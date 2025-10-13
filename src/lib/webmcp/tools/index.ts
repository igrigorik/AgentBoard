/**
 * Default WebMCP Tools Registry
 *
 * Export compiled tools registry for lifecycle injection.
 * Tools are pre-compiled by vite-plugin-webmcp-compiler into self-registering files
 * that can be injected via chrome.scripting files:[]
 */

export { COMPILED_TOOLS, type CompiledToolInfo } from './registry';

// DEPRECATED: Legacy DEFAULT_TOOLS Map for backward compatibility with user scripts
// User scripts still use dynamic injection (works on permissive CSP only)
// TODO: Remove after user script handling is fully separated
export const DEFAULT_TOOLS = new Map<string, string>([]);
