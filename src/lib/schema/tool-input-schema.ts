import { Validator, type Schema as CfWorkerSchema, type SchemaDraft } from '@cfworker/json-schema';
import { jsonSchema, type Schema } from 'ai';
import type { JSONSchema7 } from 'json-schema';

export type ToolArguments = Record<string, unknown>;

type ToolInputValidation =
  | { success: true; value: ToolArguments }
  | { success: false; error: Error };

export interface PreparedToolInputSchema {
  inputSchema: Schema<ToolArguments>;
  validateInput: (value: unknown) => ToolInputValidation;
}

const JSON_SCHEMA_TYPES = new Set([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
]);
const SCHEMA_MAP_KEYWORDS = ['$defs', 'definitions', 'dependentSchemas', 'properties'] as const;
const SCHEMA_ARRAY_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;
const SCHEMA_VALUE_KEYWORDS = ['contains', 'else', 'if', 'not', 'then'] as const;
const BOOLEAN_OR_SCHEMA_KEYWORDS = [
  'additionalItems',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
] as const;
const NONNEGATIVE_INTEGER_KEYWORDS = [
  'maxContains',
  'maxItems',
  'maxLength',
  'maxProperties',
  'minContains',
  'minItems',
  'minLength',
  'minProperties',
] as const;
const FINITE_NUMBER_KEYWORDS = ['maximum', 'minimum'] as const;
const STRING_KEYWORDS = [
  '$anchor',
  '$comment',
  '$id',
  '$schema',
  'contentEncoding',
  'contentMediaType',
  'description',
  'title',
] as const;
const BOOLEAN_KEYWORDS = ['deprecated', 'readOnly', 'uniqueItems', 'writeOnly'] as const;

const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_SCHEMA_DEPTH = 48;
const MAX_SCHEMA_NODES = 4_096;
const MAX_SCHEMA_STRING_CHARS = 256 * 1024;
const MAX_INPUT_DEPTH = 64;
const MAX_INPUT_NODES = 10_000;
const MAX_INPUT_STRING_CHARS = 256 * 1024;
const MAX_SCHEMA_KEY_CHARS = 256;
const MAX_INPUT_KEY_CHARS = 1_024;
const MAX_ERROR_VALUE_BYTES = 512;
const MAX_COMPOSITION_BRANCHES = 16;
const MAX_VALIDATION_WORK = 4_096;

export class InvalidToolInputSchemaError extends Error {
  constructor() {
    super('Tool input schema is invalid');
    this.name = 'InvalidToolInputSchemaError';
  }
}

function invalidSchema(): never {
  throw new InvalidToolInputSchemaError();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

interface JSONComplexityLimits {
  maxDepth: number;
  maxNodes: number;
  maxStringChars: number;
  maxKeyChars: number;
}

function assertBoundedJSON(value: unknown, limits: JSONComplexityLimits): number {
  const active = new Set<object>();
  let nodes = 0;
  let stringChars = 0;

  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > limits.maxNodes || depth > limits.maxDepth) invalidSchema();

    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) invalidSchema();
      return;
    }
    if (typeof current === 'string') {
      stringChars += current.length;
      if (stringChars > limits.maxStringChars) invalidSchema();
      return;
    }
    if (typeof current !== 'object') invalidSchema();

    if (active.has(current)) invalidSchema();
    active.add(current);

    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
    } else {
      if (!isPlainRecord(current)) invalidSchema();
      for (const [key, nested] of Object.entries(current)) {
        if (key.length > limits.maxKeyChars) invalidSchema();
        stringChars += key.length;
        if (stringChars > limits.maxStringChars) invalidSchema();
        visit(nested, depth + 1);
      }
    }

    active.delete(current);
  };

  visit(value, 0);
  return nodes;
}

function assertStringArray(value: unknown): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.length > MAX_SCHEMA_KEY_CHARS)
  ) {
    invalidSchema();
  }
  if (new Set(value).size !== value.length) invalidSchema();
}

function hasAnyKeyword(schema: Record<string, unknown>, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => keyword in schema);
}

function assertErrorValueBounded(value: unknown): void {
  try {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).byteLength > MAX_ERROR_VALUE_BYTES) invalidSchema();
  } catch (error) {
    if (error instanceof InvalidToolInputSchemaError) throw error;
    return invalidSchema();
  }
}

function assertSchemaNode(value: unknown, depth: number, draft: SchemaDraft): void {
  // Boolean subschemas are valid JSON Schema but current function-call adapters serialize them
  // inconsistently. additionalProperties-style booleans are handled separately below.
  if (!isPlainRecord(value)) invalidSchema();

  // These otherwise-valid features execute untrusted regexes, recurse, or invoke quadratic work in
  // the CSP-safe interpreter. Keep the accepted function-tool profile deliberately smaller.
  if (
    hasAnyKeyword(value, [
      'pattern',
      'patternProperties',
      'format',
      'propertyNames',
      '$ref',
      '$recursiveAnchor',
      '$recursiveRef',
      '$dynamicAnchor',
      '$dynamicRef',
      '$vocabulary',
    ]) ||
    value.uniqueItems === true ||
    (depth > 0 && '$schema' in value)
  ) {
    invalidSchema();
  }

  if (
    (draft === '4' &&
      hasAnyKeyword(value, [
        '$anchor',
        '$defs',
        'const',
        'contains',
        'contentEncoding',
        'contentMediaType',
        'dependentRequired',
        'dependentSchemas',
        'if',
        'then',
        'else',
        'maxContains',
        'minContains',
        'prefixItems',
        'propertyNames',
        'unevaluatedItems',
        'unevaluatedProperties',
      ])) ||
    (draft === '7' &&
      hasAnyKeyword(value, [
        '$anchor',
        '$defs',
        'dependentRequired',
        'dependentSchemas',
        'maxContains',
        'minContains',
        'prefixItems',
        'unevaluatedItems',
        'unevaluatedProperties',
      ])) ||
    (draft === '2019-09' && 'prefixItems' in value) ||
    (draft === '2020-12' && hasAnyKeyword(value, ['additionalItems', 'dependencies']))
  ) {
    invalidSchema();
  }

  if ('const' in value) assertErrorValueBounded(value.const);

  if ('type' in value) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    if (
      types.length === 0 ||
      types.some((type) => typeof type !== 'string' || !JSON_SCHEMA_TYPES.has(type)) ||
      new Set(types).size !== types.length
    ) {
      invalidSchema();
    }
  }

  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const schemas = value[keyword];
    if (schemas === undefined) continue;
    if (!isPlainRecord(schemas)) invalidSchema();
    for (const schema of Object.values(schemas)) assertSchemaNode(schema, depth + 1, draft);
  }

  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    const schemas = value[keyword];
    if (schemas === undefined) continue;
    if (
      !Array.isArray(schemas) ||
      schemas.length === 0 ||
      schemas.length > MAX_COMPOSITION_BRANCHES
    ) {
      invalidSchema();
    }
    for (const schema of schemas) assertSchemaNode(schema, depth + 1, draft);
  }

  for (const keyword of SCHEMA_VALUE_KEYWORDS) {
    const schema = value[keyword];
    if (schema !== undefined) assertSchemaNode(schema, depth + 1, draft);
  }

  for (const keyword of BOOLEAN_OR_SCHEMA_KEYWORDS) {
    const schema = value[keyword];
    if (schema !== undefined && typeof schema !== 'boolean') {
      assertSchemaNode(schema, depth + 1, draft);
    }
  }

  if (value.items !== undefined) {
    if (Array.isArray(value.items)) invalidSchema();
    assertSchemaNode(value.items, depth + 1, draft);
  }

  if (value.required !== undefined) assertStringArray(value.required);

  if (value.dependentRequired !== undefined) {
    if (!isPlainRecord(value.dependentRequired)) invalidSchema();
    for (const required of Object.values(value.dependentRequired)) assertStringArray(required);
  }

  if (value.dependencies !== undefined) {
    if (!isPlainRecord(value.dependencies)) invalidSchema();
    for (const dependency of Object.values(value.dependencies)) {
      if (Array.isArray(dependency)) assertStringArray(dependency);
      else assertSchemaNode(dependency, depth + 1, draft);
    }
  }

  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0) invalidSchema();
    assertErrorValueBounded(value.enum);
  }

  for (const keyword of NONNEGATIVE_INTEGER_KEYWORDS) {
    const number = value[keyword];
    if (number !== undefined && (!Number.isInteger(number) || (number as number) < 0)) {
      invalidSchema();
    }
  }

  for (const keyword of FINITE_NUMBER_KEYWORDS) {
    const number = value[keyword];
    if (number !== undefined && (typeof number !== 'number' || !Number.isFinite(number))) {
      invalidSchema();
    }
  }

  for (const keyword of STRING_KEYWORDS) {
    if (value[keyword] !== undefined && typeof value[keyword] !== 'string') invalidSchema();
  }

  for (const keyword of BOOLEAN_KEYWORDS) {
    if (value[keyword] !== undefined && typeof value[keyword] !== 'boolean') invalidSchema();
  }

  for (const keyword of ['exclusiveMaximum', 'exclusiveMinimum'] as const) {
    const limit = value[keyword];
    if (limit === undefined) continue;
    if (draft === '4') {
      if (typeof limit !== 'boolean') invalidSchema();
    } else if (typeof limit !== 'number' || !Number.isFinite(limit)) {
      invalidSchema();
    }
  }

  if (
    value.multipleOf !== undefined &&
    (typeof value.multipleOf !== 'number' ||
      !Number.isFinite(value.multipleOf) ||
      value.multipleOf <= 0)
  ) {
    invalidSchema();
  }
}

function schemaDraft(schema: Record<string, unknown>): SchemaDraft {
  if (schema.$schema === undefined) return '2020-12';
  if (typeof schema.$schema !== 'string') invalidSchema();

  const uri = schema.$schema.endsWith('#') ? schema.$schema.slice(0, -1) : schema.$schema;
  switch (uri) {
    case 'http://json-schema.org/draft-04/schema':
    case 'https://json-schema.org/draft-04/schema':
      return '4';
    case 'http://json-schema.org/draft-07/schema':
    case 'https://json-schema.org/draft-07/schema':
      return '7';
    case 'http://json-schema.org/draft/2019-09/schema':
    case 'https://json-schema.org/draft/2019-09/schema':
      return '2019-09';
    case 'http://json-schema.org/draft/2020-12/schema':
    case 'https://json-schema.org/draft/2020-12/schema':
      return '2020-12';
    default:
      return invalidSchema();
  }
}

function deepFreezeJSON(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const nested of Object.values(value)) deepFreezeJSON(nested);
  Object.freeze(value);
}

function cloneWithoutPrototypes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneWithoutPrototypes);
  if (!isPlainRecord(value)) return value;

  const clone = Object.create(null) as Record<string, unknown>;
  for (const [key, nested] of Object.entries(value)) clone[key] = cloneWithoutPrototypes(nested);
  return clone;
}

/**
 * Preserve a site's or MCP server's JSON Schema for provider serialization while compiling an
 * independent CSP-safe snapshot for runtime validation. The accepted profile deliberately excludes
 * schema features that can execute untrusted regular expressions or recurse without a work bound.
 */
export function prepareToolInputSchema(source: unknown): PreparedToolInputSchema {
  const sourceSchema =
    source === undefined ? { type: 'object', properties: {}, additionalProperties: false } : source;
  if (!isPlainRecord(sourceSchema) || sourceSchema.type !== 'object') invalidSchema();

  const schemaNodes = assertBoundedJSON(sourceSchema, {
    maxDepth: MAX_SCHEMA_DEPTH,
    maxNodes: MAX_SCHEMA_NODES,
    maxStringChars: MAX_SCHEMA_STRING_CHARS,
    maxKeyChars: MAX_SCHEMA_KEY_CHARS,
  });
  const draft = schemaDraft(sourceSchema);
  assertSchemaNode(sourceSchema, 0, draft);

  let serialized: string;
  let providerSchema: Record<string, unknown>;
  let validationSchema: Record<string, unknown>;
  try {
    serialized = JSON.stringify(sourceSchema);
    if (new TextEncoder().encode(serialized).byteLength > MAX_SCHEMA_BYTES) invalidSchema();
    // The validator mutates schemas with private lookup metadata. Two snapshots keep that state away
    // from the immutable provider contract and prevent later source-object edits from changing it.
    providerSchema = JSON.parse(serialized) as Record<string, unknown>;
    validationSchema = JSON.parse(serialized) as Record<string, unknown>;
    deepFreezeJSON(providerSchema);
  } catch (error) {
    if (error instanceof InvalidToolInputSchemaError) throw error;
    return invalidSchema();
  }

  let validator: Validator;
  try {
    validator = new Validator(validationSchema as CfWorkerSchema, draft, true);
    // Construction does not validate schema structure. This catches unconditional runtime faults;
    // recursive and reference-bearing schemas are excluded by the profile above.
    validator.validate(Object.create(null));
  } catch {
    return invalidSchema();
  }

  const validateInput = (value: unknown): ToolInputValidation => {
    try {
      if (!isPlainRecord(value)) throw new Error();
      const inputNodes = assertBoundedJSON(value, {
        maxDepth: MAX_INPUT_DEPTH,
        maxNodes: MAX_INPUT_NODES,
        maxStringChars: MAX_INPUT_STRING_CHARS,
        maxKeyChars: MAX_INPUT_KEY_CHARS,
      });
      if (schemaNodes * inputNodes > MAX_VALIDATION_WORK) throw new Error();
      if (!validator.validate(cloneWithoutPrototypes(value)).valid) throw new Error();
      return { success: true, value };
    } catch {
      // AI SDK may echo model-generated input back to the model. Keep the validator-specific cause
      // fixed so page, UI, and log boundaries never need to handle arbitrary validation details.
      return {
        success: false,
        error: new Error('Tool arguments do not match the declared schema'),
      };
    }
  };

  return {
    inputSchema: jsonSchema<ToolArguments>(providerSchema as JSONSchema7, {
      validate: validateInput,
    }),
    validateInput,
  };
}
