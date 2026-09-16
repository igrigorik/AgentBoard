import { describe, expect, it } from 'vitest';
import { prepareToolInputSchema } from '../src/lib/schema/tool-input-schema';

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const nested of Object.values(value)) deepFreeze(nested);
  Object.freeze(value);
}

describe('tool input JSON Schema', () => {
  it('publishes a frozen verbatim provider snapshot without a validate callback', () => {
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

    expect(prepared.jsonSchema).not.toBe(schema);
    expect(prepared.jsonSchema).toEqual(expectedSchema);
    expect(Object.isFrozen(prepared.jsonSchema)).toBe(true);
    expect(prepared.validate).toBeUndefined();
  });

  it('keeps the published snapshot stable after the source object changes', () => {
    const source = {
      type: 'object',
      required: ['value'],
      properties: { value: { type: 'string' } },
      additionalProperties: false,
    };
    const prepared = prepareToolInputSchema(source);

    source.properties.value.type = 'number';

    expect(prepared.jsonSchema).toMatchObject({ properties: { value: { type: 'string' } } });
  });

  it('publishes constraint vocabulary it does not interpret, exactly as the tool declared it', () => {
    // A NetHack session tool: the regexes, uniqueness, formats, and references belong to the tool.
    const schema = {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
        name: { type: 'string', pattern: '^[^\\u0000-\\u001f\\u007f]*$', 'x-maxBytes': 31 },
        startedAt: { type: 'string', format: 'date-time' },
        itemTypes: { type: 'array', uniqueItems: true, items: { $ref: '#/$defs/itemType' } },
        symbol: { type: 'string', pattern: '^(a+)+$' },
      },
      propertyNames: { pattern: '^[a-z]' },
      patternProperties: { '^x-': { type: 'string' } },
      $defs: { itemType: { type: 'string', enum: ['weapon', 'armor'] } },
      additionalProperties: false,
    };

    const prepared = prepareToolInputSchema(schema);

    expect(prepared.jsonSchema).toEqual(schema);
    expect(prepared.validate).toBeUndefined();
  });

  it('treats only an omitted schema as a strict no-parameter contract', () => {
    expect(prepareToolInputSchema(undefined).jsonSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
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

  // Providers refuse the whole request over one malformed input_schema, so keyword values must at
  // least have the JSON type the vocabulary defines. Which constraint they express is not judged.
  it.each([
    ['properties container', { type: 'object', properties: 'invalid' }],
    ['required container', { type: 'object', required: 'invalid' }],
    ['duplicate required names', { type: 'object', required: ['a', 'a'] }],
    ['nested property', { type: 'object', properties: { value: null } }],
    ['boolean property schema', { type: 'object', properties: { value: false } }],
    ['unknown type name', { type: 'object', properties: { value: { type: 'BOOLEAN' } } }],
    ['composition container', { type: 'object', allOf: {} }],
    ['empty composition', { type: 'object', anyOf: [] }],
    [
      'tuple-form items',
      { type: 'object', properties: { values: { type: 'array', items: [{ type: 'string' }] } } },
    ],
    [
      'numeric keyword',
      { type: 'object', properties: { value: { type: 'string', minLength: 'invalid' } } },
    ],
    [
      'negative count keyword',
      { type: 'object', properties: { value: { type: 'array', maxItems: -1 } } },
    ],
    ['non-string pattern', { type: 'object', properties: { value: { pattern: /a/ } } }],
    ['non-string reference', { type: 'object', properties: { value: { $ref: 1 } } }],
    ['non-boolean uniqueItems', { type: 'object', properties: { value: { uniqueItems: 'yes' } } }],
    ['empty enum', { type: 'object', properties: { value: { enum: [] } } }],
    ['non-positive multipleOf', { type: 'object', properties: { value: { multipleOf: 0 } } }],
    [
      'non-finite bound',
      { type: 'object', properties: { value: { type: 'number', maximum: Infinity } } },
    ],
    ['dependentRequired container', { type: 'object', dependentRequired: ['value'] }],
  ])('rejects a malformed %s', (_name, schema) => {
    expect(() => prepareToolInputSchema(schema)).toThrow('Tool input schema is invalid');
  });

  it('accepts both draft spellings of exclusive bounds', () => {
    expect(() =>
      prepareToolInputSchema({
        type: 'object',
        properties: {
          legacy: { type: 'number', minimum: 0, exclusiveMinimum: true },
          modern: { type: 'number', exclusiveMinimum: 0 },
        },
      })
    ).not.toThrow();
    expect(() =>
      prepareToolInputSchema({
        type: 'object',
        properties: { value: { type: 'number', exclusiveMinimum: 'zero' } },
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

  it('bounds schema property names', () => {
    expect(() =>
      prepareToolInputSchema({
        type: 'object',
        properties: { ['s'.repeat(257)]: { type: 'string' } },
      })
    ).toThrow('Tool input schema is invalid');
  });

  it('accepts a large real-world schema that the previous validation budget could not execute', () => {
    // ~600 schema nodes: the size at which the removed schemaNodes × inputNodes ≤ 4096 budget
    // failed every realistic call with a spurious "arguments do not match" error.
    const variants = Array.from({ length: 12 }, (_, index) => ({
      type: 'object',
      required: ['action'],
      properties: {
        action: { const: `action_${index}` },
        target: {
          oneOf: [
            { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } } },
            { type: 'object', properties: { direction: { enum: ['n', 's', 'e', 'w'] } } },
            { type: 'object', properties: { symbol: { type: 'string', pattern: '^[!-~]$' } } },
          ],
        },
        options: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: 6 }, (_, option) => [
              `option_${option}`,
              { type: 'boolean', description: `Option ${option}` },
            ])
          ),
        },
      },
    }));

    const prepared = prepareToolInputSchema({
      type: 'object',
      required: ['sessionId'],
      properties: { sessionId: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' } },
      oneOf: variants,
    });

    expect(prepared.jsonSchema).toMatchObject({ oneOf: expect.any(Array) });
    expect(prepared.validate).toBeUndefined();
  });
});
