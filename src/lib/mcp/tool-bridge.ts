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
    execute: async (
      args: z.infer<typeof zodSchema>,
      { abortSignal }: { abortSignal?: AbortSignal } = {}
    ) => {
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
          signal: abortSignal,
        });

        // MCP uses a resolved isError result for semantic tool failures. Treat it
        // like a thrown failure before any server-supplied diagnostic can escape.
        if (result.isError) throw new Error('MCP tool execution failed');

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
      } catch {
        log.error('MCP tool execution failed');
        throw new Error('MCP tool execution failed');
      }
    },
  };

  return tool(toolDefinition);
}
