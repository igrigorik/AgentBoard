/**
 * Default WebMCP Tools Registry
 *
 * Export compiled tools registry for lifecycle injection.
 * Tools are pre-compiled by vite-plugin-webmcp-compiler into self-registering files
 * that can be injected via chrome.scripting files:[]
 */

export { COMPILED_TOOLS, type CompiledToolInfo } from './registry';
