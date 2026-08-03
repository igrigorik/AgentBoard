/**
 * MCP to AI SDK Tool Bridge
 * Converts MCP tools to AI SDK format for use with streamText
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { tool } from 'ai';
import log from '../logger';
import { prepareToolInputSchema, type ToolArguments } from '../schema/tool-input-schema';
import type { RemoteMCPSession, RemoteMCPToolCapability } from './manager';

/**
 * Convert an MCP tool to AI SDK tool format
 */
export function convertMCPToAISDKTool(
  session: RemoteMCPSession,
  capability: RemoteMCPToolCapability
) {
  const { tool: mcpTool } = capability;

  const preparedSchema = prepareToolInputSchema(mcpTool.inputSchema);

  const toolDefinition = {
    description: mcpTool.description || `Tool: ${mcpTool.name}`,
    inputSchema: preparedSchema.inputSchema,
    execute: async (args: ToolArguments, { abortSignal }: { abortSignal?: AbortSignal } = {}) => {
      try {
        // Keep the remote side-effect boundary independently fail-closed even if validation in the
        // AI SDK call path is accidentally bypassed in a future refactor.
        if (!preparedSchema.validateInput(args).success) {
          throw new Error('MCP tool arguments are invalid');
        }

        const result = await session.executeTool(capability, args, abortSignal);

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
