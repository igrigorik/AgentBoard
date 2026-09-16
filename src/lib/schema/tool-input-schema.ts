import { jsonSchema, type Schema } from 'ai';
import type { JSONSchema7 } from 'json-schema';

export type ToolArguments = Record<string, unknown>;

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
  '$ref',
  '$schema',
  'contentEncoding',
  'contentMediaType',
  'description',
  'format',
  'pattern',
  'title',
] as const;
const BOOLEAN_KEYWORDS = ['deprecated', 'readOnly', 'uniqueItems', 'writeOnly'] as const;

const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_SCHEMA_DEPTH = 48;
const MAX_SCHEMA_NODES = 4_096;
const MAX_SCHEMA_STRING_CHARS = 256 * 1024;
const MAX_SCHEMA_KEY_CHARS = 256;

export class InvalidToolInputSchemaError extends Error {
  constructor() {
    super('Tool input schema is invalid');
    this.name = 'InvalidToolInputSchemaError';
  }
}

function invalidSchema(): never {
  throw new InvalidToolInputSchemaError();
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertBoundedJSON(value: unknown): void {
  const active = new Set<object>();
  let nodes = 0;
  let stringChars = 0;

  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) invalidSchema();

    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) invalidSchema();
      return;
    }
    if (typeof current === 'string') {
      stringChars += current.length;
      if (stringChars > MAX_SCHEMA_STRING_CHARS) invalidSchema();
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
        if (key.length > MAX_SCHEMA_KEY_CHARS) invalidSchema();
        stringChars += key.length;
        if (stringChars > MAX_SCHEMA_STRING_CHARS) invalidSchema();
        visit(nested, depth + 1);
      }
    }

    active.delete(current);
  };

  visit(value, 0);
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

/**
 * Structural sanity only: every keyword whose value has the wrong JSON type is rejected because
 * OpenAI and Anthropic refuse the whole request over one malformed `input_schema`, taking every
 * sibling tool down with it. Which constraints a keyword expresses is not judged here.
 */
function assertSchemaNode(value: unknown): void {
  // Boolean subschemas are valid JSON Schema but current function-call adapters serialize them
  // inconsistently. additionalProperties-style booleans are handled separately below.
  if (!isPlainRecord(value)) invalidSchema();

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
    for (const schema of Object.values(schemas)) assertSchemaNode(schema);
  }

  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    const schemas = value[keyword];
    if (schemas === undefined) continue;
    if (!Array.isArray(schemas) || schemas.length === 0) invalidSchema();
    for (const schema of schemas) assertSchemaNode(schema);
  }

  for (const keyword of SCHEMA_VALUE_KEYWORDS) {
    const schema = value[keyword];
    if (schema !== undefined) assertSchemaNode(schema);
  }

  for (const keyword of BOOLEAN_OR_SCHEMA_KEYWORDS) {
    const schema = value[keyword];
    if (schema !== undefined && typeof schema !== 'boolean') assertSchemaNode(schema);
  }

  if (value.items !== undefined) {
    if (Array.isArray(value.items)) invalidSchema();
    assertSchemaNode(value.items);
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
      else assertSchemaNode(dependency);
    }
  }

  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0)) {
    invalidSchema();
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

  // Draft 4 spells these as booleans qualifying minimum/maximum; later drafts use numbers.
  for (const keyword of ['exclusiveMaximum', 'exclusiveMinimum'] as const) {
    const limit = value[keyword];
    if (limit === undefined || typeof limit === 'boolean') continue;
    if (typeof limit !== 'number' || !Number.isFinite(limit)) invalidSchema();
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

function deepFreezeJSON(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const nested of Object.values(value)) deepFreezeJSON(nested);
  Object.freeze(value);
}

/**
 * Publish a site's or MCP server's JSON Schema to providers verbatim.
 *
 * AgentBoard does not validate model arguments against third-party schemas. The tool owns its
 * constraints and is the only party that can judge them: it rejects what the model gets wrong with
 * a message written by whoever wrote the constraint, and MCP-idiomatic tools return that rejection
 * as an `isError` result the model reads directly. Interpreting untrusted schemas here instead
 * would make the extension hostage to their vocabulary (a `pattern` on one property once hid an
 * entire tool) and to their regexes. The only checks that remain protect the shared provider
 * request: an object root, bounded size, and keyword values of the JSON type providers accept.
 */
export function prepareToolInputSchema(source: unknown): Schema<ToolArguments> {
  const sourceSchema =
    source === undefined ? { type: 'object', properties: {}, additionalProperties: false } : source;
  if (!isPlainRecord(sourceSchema) || sourceSchema.type !== 'object') invalidSchema();

  assertBoundedJSON(sourceSchema);
  assertSchemaNode(sourceSchema);

  let providerSchema: Record<string, unknown>;
  try {
    const serialized = JSON.stringify(sourceSchema);
    if (new TextEncoder().encode(serialized).byteLength > MAX_SCHEMA_BYTES) invalidSchema();
    // A private snapshot keeps later edits to the source object from changing the published
    // contract, and freezing it lets the cache fingerprint trust the reference it hashes.
    providerSchema = JSON.parse(serialized) as Record<string, unknown>;
    deepFreezeJSON(providerSchema);
  } catch (error) {
    if (error instanceof InvalidToolInputSchemaError) throw error;
    return invalidSchema();
  }

  return jsonSchema<ToolArguments>(providerSchema as JSONSchema7);
}
