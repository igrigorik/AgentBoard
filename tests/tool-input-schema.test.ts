import { describe, expect, it } from 'vitest';
import { prepareToolInputSchema } from '../src/lib/schema/tool-input-schema';

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const nested of Object.values(value)) deepFreeze(nested);
  Object.freeze(value);
}

function expectInvalid(
  result: ReturnType<ReturnType<typeof prepareToolInputSchema>['validateInput']>
): void {
  expect(result).toEqual({
    success: false,
    error: new Error('Tool arguments do not match the declared schema'),
  });
}

describe('tool input JSON Schema', () => {
  it('preserves a frozen provider schema while validating an independent snapshot', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['catalog'],
      properties: {
        catalog: {
          type: 'object',
          required: ['variant_id'],
          additionalProperties: false,
          properties: {
            variant_id: {
              type: ['string', 'number'],
              description: 'ProductVariant GID or numeric variant ID.',
            },
          },
        },
      },
      additionalProperties: false,
    };
    const expectedSchema = structuredClone(schema);
    deepFreeze(schema);

    const prepared = prepareToolInputSchema(schema);
    const input = { catalog: { variant_id: 123 } };
    const result = prepared.validateInput(input);

    expect(prepared.inputSchema.jsonSchema).not.toBe(schema);
    expect(prepared.inputSchema.jsonSchema).toEqual(expectedSchema);
    expect(Object.isFrozen(prepared.inputSchema.jsonSchema)).toBe(true);
    expect(result.success).toBe(true);
    if (result.success) expect(result.value).toBe(input);
    expect(Object.isFrozen(schema.properties.catalog.properties.variant_id)).toBe(true);
  });

  it('keeps provider and validation snapshots stable after the source object changes', () => {
    const source = {
      type: 'object',
      required: ['value'],
      properties: { value: { type: 'string' } },
      additionalProperties: false,
    };
    const prepared = prepareToolInputSchema(source);

    source.properties.value.type = 'number';

    expect(prepared.inputSchema.jsonSchema).toMatchObject({
      properties: { value: { type: 'string' } },
    });
    expect(prepared.validateInput({ value: 'stable' }).success).toBe(true);
    expectInvalid(prepared.validateInput({ value: 42 }));
  });

  it('enforces nested requirements, ranges, unions, and additional properties', () => {
    const prepared = prepareToolInputSchema({
      type: 'object',
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 2,
          items: {
            type: 'object',
            required: ['id', 'quantity'],
            properties: {
              id: { type: ['string', 'number'] },
              quantity: { type: 'integer', minimum: 1, maximum: 5 },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    });

    expect(prepared.validateInput({ items: [{ id: 'one', quantity: 2 }] }).success).toBe(true);
    expectInvalid(prepared.validateInput({ items: [{ id: true, quantity: 2 }] }));
    expectInvalid(prepared.validateInput({ items: [{ id: 1, quantity: 0 }] }));
    expectInvalid(prepared.validateInput({ items: [{ id: 1, quantity: 2, secret: true }] }));
    expectInvalid(prepared.validateInput({ items: [] }));
  });

  it('treats only an omitted schema as a strict no-parameter contract', () => {
    const prepared = prepareToolInputSchema(undefined);
    const empty = {};
    const result = prepared.validateInput(empty);

    expect(prepared.inputSchema.jsonSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.value).toBe(empty);
    expectInvalid(prepared.validateInput({ unexpected: true }));
  });

  it.each([
    ['null', null],
    ['boolean true', true],
    ['boolean false', false],
    ['array', []],
    ['string', 'object'],
    ['number', 1],
    ['missing root type', {}],
    ['non-object root type', { type: 'string' }],
    ['root type union', { type: ['object', 'null'] }],
  ])('rejects an unusable %s root schema', (_name, schema) => {
    expect(() => prepareToolInputSchema(schema)).toThrow('Tool input schema is invalid');
  });

  it.each([
    ['properties container', { type: 'object', properties: 'invalid' }],
    ['required container', { type: 'object', required: 'invalid' }],
    ['nested property', { type: 'object', properties: { value: null } }],
    ['boolean property schema', { type: 'object', properties: { value: false } }],
    ['composition container', { type: 'object', allOf: {} }],
    [
      'excessive composition branches',
      { type: 'object', allOf: Array.from({ length: 17 }, () => ({ type: 'object' })) },
    ],
    [
      'tuple-form items',
      { type: 'object', properties: { values: { type: 'array', items: [{ type: 'string' }] } } },
    ],
    [
      'numeric keyword',
      { type: 'object', properties: { value: { type: 'string', minLength: 'invalid' } } },
    ],
    [
      'regular expression',
      { type: 'object', properties: { value: { type: 'string', pattern: '^(a+)+$' } } },
    ],
    [
      'format validator',
      { type: 'object', properties: { value: { type: 'string', format: 'url' } } },
    ],
    ['schema reference', { type: 'object', properties: { value: { $ref: '#/$defs/value' } } }],
    ['property-name validator', { type: 'object', propertyNames: { type: 'string' } }],
    [
      'large const diagnostic',
      { type: 'object', properties: { value: { const: 'x'.repeat(513) } } },
    ],
    [
      'large enum diagnostic',
      { type: 'object', properties: { value: { enum: ['x'.repeat(513)] } } },
    ],
    [
      'quadratic uniqueness check',
      { type: 'object', properties: { values: { type: 'array', uniqueItems: true } } },
    ],
  ])('rejects an unsafe or malformed %s', (_name, schema) => {
    expect(() => prepareToolInputSchema(schema)).toThrow('Tool input schema is invalid');
  });

  it('applies declared draft semantics and rejects unsupported metaschemas', () => {
    expect(() =>
      prepareToolInputSchema({
        $schema: 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        properties: { value: { type: 'number', exclusiveMinimum: true } },
      })
    ).not.toThrow();
    expect(() =>
      prepareToolInputSchema({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { value: { type: 'number', exclusiveMinimum: true } },
      })
    ).toThrow('Tool input schema is invalid');
    expect(() =>
      prepareToolInputSchema({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        dependentRequired: { value: ['other'] },
      })
    ).toThrow('Tool input schema is invalid');
    expect(() =>
      prepareToolInputSchema({
        $schema: 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        const: {},
      })
    ).toThrow('Tool input schema is invalid');
    expect(() =>
      prepareToolInputSchema({
        $schema: 'https://example.com/draft-07/schema',
        type: 'object',
      })
    ).toThrow('Tool input schema is invalid');
  });

  it('rejects cyclic, overdeep, and overwide schemas', () => {
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.self = cyclic;
    expect(() => prepareToolInputSchema(cyclic)).toThrow('Tool input schema is invalid');

    let nested: Record<string, unknown> = { type: 'string' };
    for (let depth = 0; depth < 50; depth += 1) {
      nested = { type: 'object', properties: { value: nested } };
    }
    expect(() => prepareToolInputSchema(nested)).toThrow('Tool input schema is invalid');

    const properties = Object.fromEntries(
      Array.from({ length: 2_100 }, (_, index) => [`p${index}`, { type: 'string' }])
    );
    expect(() => prepareToolInputSchema({ type: 'object', properties })).toThrow(
      'Tool input schema is invalid'
    );
  });

  it('rejects overlarge model argument trees', () => {
    const prepared = prepareToolInputSchema({
      type: 'object',
      properties: {
        values: { type: 'array', items: { type: 'number' } },
      },
      additionalProperties: false,
    });
    expectInvalid(prepared.validateInput({ values: Array.from({ length: 10_001 }, (_, i) => i) }));
  });

  it('allows array contracts when total validation work is bounded', () => {
    const prepared = prepareToolInputSchema({
      type: 'object',
      required: ['values'],
      properties: {
        values: {
          type: 'array',
          minItems: 101,
          maxItems: 101,
          items: { type: 'number' },
        },
      },
      additionalProperties: false,
    });

    expect(
      prepared.validateInput({ values: Array.from({ length: 101 }, (_, index) => index) }).success
    ).toBe(true);
  });

  it('bounds multiplicative validator work before interpreting the schema', () => {
    const prepared = prepareToolInputSchema({
      type: 'object',
      allOf: Array.from({ length: 16 }, () => ({ additionalProperties: true })),
    });

    expect(prepared.validateInput({ value: 1 }).success).toBe(true);
    expectInvalid(
      prepared.validateInput(
        Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`p${index}`, index]))
      )
    );
  });

  it('bounds schema and model property names that validators may repeat in errors', () => {
    expect(() =>
      prepareToolInputSchema({
        type: 'object',
        properties: { ['s'.repeat(257)]: { type: 'string' } },
      })
    ).toThrow('Tool input schema is invalid');

    const prepared = prepareToolInputSchema({ type: 'object', additionalProperties: true });
    expectInvalid(prepared.validateInput({ ['i'.repeat(1_025)]: true }));
  });

  it('does not satisfy required properties through Object.prototype', () => {
    const prepared = prepareToolInputSchema({
      type: 'object',
      required: ['toString'],
      properties: { toString: { type: 'string' } },
      additionalProperties: false,
    });

    expectInvalid(prepared.validateInput({}));
    expect(prepared.validateInput({ toString: 'owned' }).success).toBe(true);
  });

  it('does not apply schema defaults or otherwise rewrite valid arguments', () => {
    const prepared = prepareToolInputSchema({
      type: 'object',
      properties: { maxLength: { type: 'number', default: 32_000 } },
      additionalProperties: false,
    });
    const input = {};
    const result = prepared.validateInput(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBe(input);
      expect(result.value).not.toHaveProperty('maxLength');
    }
  });
});
