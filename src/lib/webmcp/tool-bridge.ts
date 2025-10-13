/**
 * WebMCP to AI SDK Tool Bridge
 * Converts WebMCP tools (from sites and user scripts) to AI SDK format
 *
 * Design: Parallel to MCP tool bridge - same conversion approach,
 * executes via the TabManager in the background context
 */

import log from '../logger';
import { tool } from 'ai';
import { z } from 'zod';
import { getTabManager } from './lifecycle';

/**
 * Convert a WebMCP tool to AI SDK tool format
 * Handles execution differently based on context (background vs content/popup)
 */
// Convert JSON Schema (draft-ish) to Zod - mirrors MCP converter behavior for consistency
type JSONSchemaLike = {
  type?: string;
  enum?: string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: unknown;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  anyOf?: unknown[];
  oneOf?: unknown[];
  description?: string;
};

function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.object({});
  const sch = schema as JSONSchemaLike;

  // Handle boolean schemas
  if (typeof (sch as unknown) === 'boolean') {
    return (sch as unknown as boolean) ? z.any() : z.never();
  }

  // Handle type switch
  switch (sch.type) {
    case 'string': {
      let s = z.string();
      if (sch.enum) return z.enum(sch.enum as [string, ...string[]]);
      if (typeof sch.minLength === 'number') s = s.min(sch.minLength);
      if (typeof sch.maxLength === 'number') s = s.max(sch.maxLength);
      if (sch.description) s = s.describe(sch.description);
      return s;
    }
    case 'number':
    case 'integer': {
      let n = sch.type === 'integer' ? z.number().int() : z.number();
      if (typeof sch.minimum === 'number') n = n.min(sch.minimum);
      if (typeof sch.maximum === 'number') n = n.max(sch.maximum);
      return n;
    }
    case 'boolean':
      return z.boolean();
    case 'array': {
      const itemSchema = sch.items ? jsonSchemaToZod(sch.items) : z.any();
      let arr = z.array(itemSchema);
      if (typeof sch.minItems === 'number') arr = arr.min(sch.minItems);
      if (typeof sch.maxItems === 'number') arr = arr.max(sch.maxItems);
      return arr;
    }
    case 'object': {
      const shape: Record<string, z.ZodTypeAny> = {};
      const properties = (sch.properties || {}) as Record<string, unknown>;
      const required: string[] = Array.isArray(sch.required) ? sch.required : [];
      for (const [key, prop] of Object.entries(properties)) {
        const propZod = jsonSchemaToZod(prop);
        shape[key] = required.includes(key) ? propZod : propZod.optional();
      }
      let obj = z.object(shape);
      // Note: additionalProperties false would require strict + catchall never
      if (sch.additionalProperties === false) {
        try {
          const maybeCatchall = obj as unknown as {
            catchall?: (arg: z.ZodTypeAny) => z.ZodTypeAny;
          };
          const maybeStrict = obj as unknown as { strict?: () => z.ZodTypeAny };
          if (typeof maybeCatchall.catchall === 'function') {
            obj = maybeCatchall.catchall(z.never()) as unknown as typeof obj;
          }
          if (typeof maybeStrict.strict === 'function') {
            obj = maybeStrict.strict() as unknown as typeof obj;
          }
        } catch {
          // Best-effort; ignore if methods not present
        }
      }
      return obj;
    }
    default: {
      // Handle unions anyOf/oneOf
      if (Array.isArray(sch.anyOf) && sch.anyOf.length > 0) {
        const variants = (sch.anyOf as unknown[]).map((v) => jsonSchemaToZod(v));
        return variants.length >= 2 ? z.union([variants[0], variants[1]]) : variants[0] || z.any();
      }
      if (Array.isArray(sch.oneOf) && sch.oneOf.length > 0) {
        const variants = (sch.oneOf as unknown[]).map((v) => jsonSchemaToZod(v));
        return variants.length >= 2 ? z.union([variants[0], variants[1]]) : variants[0] || z.any();
      }
      // If properties without type, assume object
      if (sch.properties && !sch.type) {
        const shape: Record<string, z.ZodTypeAny> = {};
        const required: string[] = Array.isArray(sch.required) ? sch.required : [];
        for (const [key, prop] of Object.entries(sch.properties as Record<string, unknown>)) {
          const propZod = jsonSchemaToZod(prop);
          shape[key] = required.includes(key) ? propZod : propZod.optional();
        }
        return z.object(shape);
      }
      return z.any();
    }
  }
}

export function convertWebMCPToAISDKTool(
  webmcpTool: {
    name: string;
    description?: string;
    inputSchema?: unknown;
  },
  tabId: number // The tab where this tool was registered
) {
  // Convert the input schema to Zod
  let zodSchema: z.ZodTypeAny = z.object({});
  try {
    zodSchema = jsonSchemaToZod(webmcpTool.inputSchema);
  } catch (error) {
    log.error(`Failed to convert schema for WebMCP tool "${webmcpTool.name}":`, error);
  }

  const toolDefinition = {
    description: webmcpTool.description || `Tool: ${webmcpTool.name}`,
    inputSchema: zodSchema,
    execute: async (args: unknown) => {
      log.debug(`[WebMCP Tool Bridge] Executing tool ${webmcpTool.name}:`, args);
      log.debug(`[WebMCP Tool Bridge] Tool was registered from tab ${tabId}`);

      try {
        // We're always running in the background service worker
        log.debug(`[WebMCP Tool Bridge] Executing tool ${webmcpTool.name} from tab ${tabId}`);

        // Directly use the tab manager
        const tabManager = getTabManager();

        // Find the right tab - prefer one with an active connection
        const registries = tabManager.getAllRegistries();
        let targetTabId = tabId;

        // Check if original tab still has connection
        if (!registries.has(tabId)) {
          log.debug(
            `[WebMCP Tool Bridge] Original tab ${tabId} not connected, searching for alternative`
          );
          // Find any tab with this tool
          for (const [tid, registry] of registries) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (registry.tools.some((t: any) => t.name === webmcpTool.name)) {
              targetTabId = tid;
              log.debug(`[WebMCP Tool Bridge] Found tool in tab ${targetTabId}`);
              break;
            }
          }
        }

        if (!registries.has(targetTabId)) {
          throw new Error(
            `No active tab found with tool "${webmcpTool.name}". Make sure the page is still open.`
          );
        }

        const result = await tabManager.callTool(targetTabId, webmcpTool.name, args || {});
        log.debug(`[WebMCP Tool Bridge] Tool executed successfully:`, result);
        return result;
      } catch (error) {
        log.error(`[WebMCP Tool Bridge] Error executing tool ${webmcpTool.name}:`, error);
        throw error;
      }
    },
  };

  return tool(toolDefinition);
}
