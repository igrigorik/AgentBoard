/**
 * Build-time sentinel for ajv-formats in Chrome extension bundles.
 *
 * The MCP SDK's ajv-provider statically imports ajv-formats, whose internal
 * `ajv/dist/compile/codegen` subpath imports escape the bare `ajv` alias and
 * bundle ~51 KB of Ajv's eval-based compiler that is dead at runtime (the MCP
 * client always supplies CfWorkerJsonSchemaValidator). This body is provably
 * unreachable today: createDefaultAjvInstance() constructs `new Ajv()` first,
 * and bare `ajv` is aliased to the throwing DisabledAjv sentinel.
 */
export default function disabledAddFormats() {
  throw new Error(
    'ajv-formats is disabled by extension CSP; configure CfWorkerJsonSchemaValidator on the MCP client'
  );
}
