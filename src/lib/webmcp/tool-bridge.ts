/**
 * WebMCP to AI SDK Tool Bridge
 * Converts WebMCP tools (from sites and user scripts) to AI SDK format
 *
 * Design: Parallel to MCP tool bridge - same conversion approach,
 * executes via the TabManager in the background context
 */

import { tool } from 'ai';
import log from '../logger';
import {
  isPlainRecord,
  prepareToolInputSchema,
  type ToolArguments,
} from '../schema/tool-input-schema';
import { getTabManager } from './lifecycle';

/**
 * Convert a WebMCP tool to AI SDK tool format, retaining the site's schema verbatim for providers.
 * Argument validation belongs to the page tool; see prepareToolInputSchema.
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
  const toolDefinition = {
    description: webmcpTool.description || `Tool: ${webmcpTool.name}`,
    inputSchema: prepareToolInputSchema(webmcpTool.inputSchema),
    execute: async (args: ToolArguments, { abortSignal }: { abortSignal?: AbortSignal } = {}) => {
      try {
        // Without a validate callback the SDK forwards any parsed JSON, and direct callers may pass
        // anything. executeTool() carries exactly one JSON object; refuse what it cannot carry.
        if (!isPlainRecord(args)) throw new Error('WebMCP tool arguments must be an object');

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

        const result = await tabManager.callTool(tabId, webmcpTool.name, args, abortSignal);
        log.debug(`[WebMCP Tool Bridge] Tool executed successfully:`, result);
        return result;
      } catch (error) {
        // Rethrow verbatim. The lifecycle already replaces forgeable page diagnostics with fixed
        // text at ingestion, so every message on this path is extension-authored; collapsing them
        // further only hid which of our own checks refused the call.
        log.error('[WebMCP Tool Bridge] Tool execution failed');
        throw error instanceof Error
          ? error
          : new Error(`WebMCP tool "${webmcpTool.name}" failed without a diagnostic.`);
      }
    },
  };

  return tool(toolDefinition);
}
