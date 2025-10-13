/**
 * Built-in Tools Metadata Aggregator
 *
 * Provides unified metadata for all built-in tools:
 * - System tools (background worker, TypeScript)
 * - WebMCP built-in tools (page context, pre-compiled)
 *
 * Used by Options UI to display tool information and source code.
 */

import { COMPILED_TOOLS, type CompiledToolInfo } from './tools/registry';
import { FETCH_URL_TOOL_NAME, FETCH_URL_METADATA } from './tools/fetch';

export type BuiltinToolType = 'system' | 'webmcp';

export interface BuiltinToolInfo {
  id: string; // Full tool ID: 'agentboard_fetch_url', 'agentboard_dom_query'
  name: string; // Display name: 'fetch_url', 'dom_query'
  namespace: string; // Always 'agentboard' for built-ins
  type: BuiltinToolType;
  description: string;
  version: string;
  match?: string[]; // URL patterns (WebMCP only)
  inputSchema?: unknown; // JSON Schema for tool arguments
}

/**
 * System tool metadata
 * Imported from tool definitions to maintain single source of truth
 */
const SYSTEM_TOOLS: BuiltinToolInfo[] = [
  {
    id: FETCH_URL_TOOL_NAME,
    name: 'fetch_url',
    namespace: 'agentboard',
    type: 'system',
    description: FETCH_URL_METADATA.description,
    version: FETCH_URL_METADATA.version,
    match: ['<all_urls>'], // Background tool - available globally on all URLs
    inputSchema: FETCH_URL_METADATA.inputSchema,
  },
];

/**
 * Convert CompiledToolInfo to BuiltinToolInfo
 * Extracts name from id (e.g., 'agentboard_dom_query' -> 'dom_query')
 */
function convertCompiledToBuiltin(compiled: CompiledToolInfo): BuiltinToolInfo {
  // Extract tool name from id (namespace_name format)
  const parts = compiled.id.split('_');
  const namespace = parts[0]; // 'agentboard'
  const name = parts.slice(1).join('_'); // 'dom_query', 'dom_readability', etc.

  return {
    id: compiled.id,
    name,
    namespace,
    type: 'webmcp',
    description: compiled.description, // Use actual description from source
    version: compiled.version,
    match: compiled.match,
    // Note: inputSchema would need to be parsed from source
    // For now, omit - can be added later if needed
  };
}

/**
 * Get all built-in tools (system + WebMCP)
 * Returns tools sorted by type (system first, then WebMCP)
 */
export function getAllBuiltinTools(): BuiltinToolInfo[] {
  const webmcpTools = COMPILED_TOOLS.map(convertCompiledToBuiltin);
  return [...SYSTEM_TOOLS, ...webmcpTools];
}

/**
 * Get a specific built-in tool by ID
 */
export function getBuiltinTool(id: string): BuiltinToolInfo | null {
  return getAllBuiltinTools().find((tool) => tool.id === id) || null;
}

/**
 * Check if a tool ID is a built-in tool
 */
export function isBuiltinTool(id: string): boolean {
  return getAllBuiltinTools().some((tool) => tool.id === id);
}
