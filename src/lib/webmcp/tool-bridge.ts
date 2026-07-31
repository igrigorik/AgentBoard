/**
 * WebMCP to AI SDK Tool Bridge
 * Converts WebMCP tools (from sites and user scripts) to AI SDK format
 *
 * Design: Parallel to MCP tool bridge - same conversion approach,
 * executes via the TabManager in the background context
 */

import log from '../logger';
import { tool, jsonSchema } from 'ai';
import type { JSONSchema7 } from 'json-schema';
import { getTabManager } from './lifecycle';
import { normalizeToolInputSchema } from '../schema/normalize-tool-input-schema';

/**
 * Convert a WebMCP tool to AI SDK tool format
 * Handles execution differently based on context (background vs content/popup)
 */
export function convertWebMCPToAISDKTool(
  webmcpTool: {
    name: string;
    description?: string;
    inputSchema?: unknown;
    annotations?: Record<string, unknown>;
  },
  tabId: number // The tab where this tool was registered
) {
  // Pass the page's JSON Schema through verbatim. A lossy JSON-Schema->Zod->JSON-Schema
  // round-trip previously dropped descriptions on non-string properties and turned
  // union types (e.g. `type: ['string','number']`) into typeless `{}` declarations,
  // which degraded provider function calling (Gemini leaked text-format tool calls).
  // Input validation stays with the page tool, matching MCP client norms.
  const toolDefinition = {
    description: webmcpTool.description || `Tool: ${webmcpTool.name}`,
    inputSchema: jsonSchema<unknown>(
      normalizeToolInputSchema(webmcpTool.inputSchema) as JSONSchema7
    ),
    execute: async (args: unknown, { abortSignal }: { abortSignal?: AbortSignal } = {}) => {
      log.debug(`[WebMCP Tool Bridge] Executing tool ${webmcpTool.name}:`, args);
      log.debug(`[WebMCP Tool Bridge] Tool was registered from tab ${tabId}`);

      try {
        // We're always running in the background service worker
        log.debug(`[WebMCP Tool Bridge] Executing tool ${webmcpTool.name} from tab ${tabId}`);

        // Directly use the tab manager
        const tabManager = getTabManager();

        // A page tool is a capability owned by the tab that registered it. Falling back to a
        // different tab by name can execute the same-named side effect against unrelated state.
        const activeRegistry = tabManager.getToolRegistry(tabId);
        if (!activeRegistry?.tools.some((tool) => tool === webmcpTool)) {
          throw new Error(
            `The tool catalog entry for "${webmcpTool.name}" is no longer active in tab ${tabId}.`
          );
        }

        const result = await tabManager.callTool(tabId, webmcpTool.name, args ?? {}, abortSignal);
        log.debug(`[WebMCP Tool Bridge] Tool executed successfully:`, result);
        return result;
      } catch {
        log.error('[WebMCP Tool Bridge] Tool execution failed');
        throw new Error('WebMCP tool execution failed');
      }
    },
  };

  return tool(toolDefinition);
}
