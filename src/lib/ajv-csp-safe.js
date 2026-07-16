/**
 * Build-time sentinel for Ajv in Chrome extension bundles.
 *
 * The MCP SDK statically imports its Ajv validator even when callers provide the
 * CSP-safe CfWorkerJsonSchemaValidator. Aliasing bare `ajv` imports to this file
 * keeps Ajv's eval-based compiler out of the bundle. Any future SDK Client that
 * forgets the explicit validator fails here with an actionable error instead of
 * violating extension CSP or silently performing partial validation.
 */
export default class DisabledAjv {
  constructor() {
    throw new Error(
      'Ajv is disabled by extension CSP; configure CfWorkerJsonSchemaValidator on the MCP client'
    );
  }
}
