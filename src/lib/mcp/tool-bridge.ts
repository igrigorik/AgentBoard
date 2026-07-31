/**
 * MCP to AI SDK Tool Bridge
 * Converts MCP tools to AI SDK format for use with streamText
 */

import log from '../logger';
import { tool, jsonSchema } from 'ai';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { RemoteMCPSession, RemoteMCPToolCapability } from './manager';
import type { JSONSchema7 } from 'json-schema';
import { normalizeToolInputSchema } from '../schema/normalize-tool-input-schema';

/**
 * Convert an MCP tool to AI SDK tool format
 */
export function convertMCPToAISDKTool(
  session: RemoteMCPSession,
  capability: RemoteMCPToolCapability
) {
  const { tool: mcpTool } = capability;

  const toolDefinition = {
    description: mcpTool.description || `Tool: ${mcpTool.name}`,
    // Server-provided JSON Schema is passed through verbatim; see
    // normalizeToolInputSchema for why the Zod round-trip was removed.
    inputSchema: jsonSchema<unknown>(normalizeToolInputSchema(mcpTool.inputSchema) as JSONSchema7),
    execute: async (args: unknown, { abortSignal }: { abortSignal?: AbortSignal } = {}) => {
      // MCP protocol expects an object for arguments, even if empty.
      const processedArgs = (
        args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {}
      ) as Record<string, unknown>;

      try {
        const result = await session.executeTool(capability, processedArgs, abortSignal);

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
