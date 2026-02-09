/**
 * MCP to AI SDK Tool Bridge
 * Converts MCP tools to AI SDK format for use with streamText
 */

import log from '../logger';
import { tool } from 'ai';
import { z } from 'zod';
import { jsonSchemaToZod } from '../schema/jsonschema-to-zod';
import type { Tool as MCPTool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getRemoteMCPManager } from './manager';
import type { JSONSchema7 } from 'json-schema';

/**
 * Convert JSON Schema to Zod schema
 * This is a simplified converter that handles common cases
 */
// Use shared converter for consistency

/**
 * Convert an MCP tool to AI SDK tool format
 */
export function convertMCPToAISDKTool(mcpTool: MCPTool, serverName: string) {
  // Convert the input schema
  let zodSchema;
  try {
    zodSchema = mcpTool.inputSchema
      ? jsonSchemaToZod(mcpTool.inputSchema as JSONSchema7)
      : z.object({});
  } catch (error) {
    log.error(`Failed to convert schema for "${mcpTool.name}":`, error);
    // Fallback to empty object schema
    zodSchema = z.object({});
  }

  const toolDefinition = {
    description: mcpTool.description || `Tool: ${mcpTool.name}`,
    inputSchema: zodSchema,
    execute: async (args: z.infer<typeof zodSchema>) => {
      const remoteMCPManager = getRemoteMCPManager();

      // MCP protocol expects an object for arguments, even if empty
      // Convert undefined/null to empty object
      const processedArgs =
        args === undefined || args === null
          ? {} // Use empty object instead of undefined/null
          : args;

      try {
        const result = await remoteMCPManager.executeTool({
          toolName: mcpTool.name,
          serverName,
          input: processedArgs,
        });

        // Extract content from MCP result
        // Prefer structuredContent (typed data) over content (text summary)
        if (result && typeof result === 'object') {
          // structuredContent has richer typed data when the server provides it
          // (MCP SDK types lag the spec — field exists at runtime via Zod passthrough)
          if ('structuredContent' in result && result.structuredContent) {
            return result.structuredContent;
          }

          if ('content' in result) {
            const content = (result as CallToolResult).content;
            if (Array.isArray(content)) {
              const textContent = content.find(
                (c): c is { type: 'text'; text: string } => c.type === 'text'
              );
              if (textContent) {
                return textContent.text;
              }
              return JSON.stringify(content);
            }
            return content;
          }
        }

        return result;
      } catch (error) {
        log.error(`Error executing MCP tool ${mcpTool.name}:`, error);
        throw error;
      }
    },
  };

  return tool(toolDefinition);
}

/**
 * Get all available MCP tools converted to AI SDK format
 */
export async function getMCPToolsForAISDK() {
  const remoteMCPManager = getRemoteMCPManager();
  const mcpTools = remoteMCPManager.getAvailableTools();
  const aiTools: Record<string, ReturnType<typeof convertMCPToAISDKTool>> = {};

  // Get server names for each tool
  // This is a simplified approach - in production you might want to track this better
  const serverStatuses = remoteMCPManager.getServerStatuses();

  for (const mcpTool of mcpTools) {
    // Find which server has this tool
    let serverName = '';
    for (const status of serverStatuses) {
      if (status.tools.some((t) => t.name === mcpTool.name)) {
        serverName = status.name;
        break;
      }
    }

    if (serverName) {
      // Use tool name as key to avoid duplicates
      aiTools[mcpTool.name] = convertMCPToAISDKTool(mcpTool, serverName);
    }
  }

  return aiTools;
}

/**
 * Load MCP configuration and initialize tools
 */
export async function initializeMCPTools() {
  try {
    log.info('[Tool Bridge] Initializing MCP tools...');

    // Use chrome.storage directly in service worker context
    const result = await chrome.storage.local.get(['config']);
    const config = result.config || { agents: [], mcpConfig: undefined };

    log.info('[Tool Bridge] Retrieved config:', {
      hasMcpConfig: !!config.mcpConfig,
      serverCount: config.mcpConfig?.mcpServers?.length || 0,
    });

    if (config.mcpConfig && config.mcpConfig.mcpServers.length > 0) {
      log.info(
        '[Tool Bridge] Loading MCP servers:',
        config.mcpConfig.mcpServers.map((s: { name: string }) => s.name)
      );

      const remoteMCPManager = getRemoteMCPManager();
      const statuses = await remoteMCPManager.loadConfig(config.mcpConfig);

      log.info('[Tool Bridge] Server connection statuses:', statuses);

      const tools = await getMCPToolsForAISDK();
      log.info('[Tool Bridge] Available tools after initialization:', Object.keys(tools));

      return tools;
    }

    return {};
  } catch (error) {
    log.error('[Tool Bridge] Error initializing MCP tools:', error);
    return {};
  }
}
