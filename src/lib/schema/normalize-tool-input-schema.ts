/**
 * Normalize a tool-provided JSON Schema for use as an AI SDK tool inputSchema.
 *
 * Tool schemas from pages (WebMCP) and remote MCP servers are passed through to
 * providers verbatim — the AI SDK provider adapters already translate JSON Schema
 * into each API's dialect (e.g. Gemini's OpenAPI subset), preserving descriptions,
 * union types, and defaults that a Zod round-trip would lose.
 *
 * This helper only guards the container shape: anything that is not a plain object
 * becomes the canonical "no parameters" schema.
 */
export function normalizeToolInputSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  return schema as Record<string, unknown>;
}
