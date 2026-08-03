/**
 * WebMCP to AI SDK Tool Bridge
 * Converts WebMCP tools (from sites and user scripts) to AI SDK format
 *
 * Design: Parallel to MCP tool bridge - same conversion approach,
 * executes via the TabManager in the background context
 */

import { tool } from 'ai';
import log from '../logger';
import { prepareToolInputSchema, type ToolArguments } from '../schema/tool-input-schema';
import { getTabManager } from './lifecycle';

/**
 * Convert a WebMCP tool to AI SDK tool format while retaining the site's schema for providers and
 * independently validating model output before the page capability can execute.
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
  const preparedSchema = prepareToolInputSchema(webmcpTool.inputSchema);

  const toolDefinition = {
    description: webmcpTool.description || `Tool: ${webmcpTool.name}`,
    inputSchema: preparedSchema.inputSchema,
    execute: async (args: ToolArguments, { abortSignal }: { abortSignal?: AbortSignal } = {}) => {
      try {
        // AI SDK validation protects the model loop; this second check keeps the actual capability
        // fail-closed if a future caller or SDK regression invokes execute() directly.
        if (!preparedSchema.validateInput(args).success) {
          throw new Error('WebMCP tool arguments are invalid');
        }

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
      } catch {
        log.error('[WebMCP Tool Bridge] Tool execution failed');
        throw new Error('WebMCP tool execution failed');
      }
    },
  };

  return tool(toolDefinition);
}
