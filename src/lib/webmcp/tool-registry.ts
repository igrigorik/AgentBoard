/**
 * Unified Tool Registry Manager
 *
 * Aggregates AI SDK tools from multiple sources:
 * - Site tools: WebMCP tools from page context
 * - User tools: WebMCP tools from user scripts
 * - Remote tools: MCP server tools from external servers
 *
 * Design Decision: Direct use of AI SDK tool format throughout.
 * Tools are converted to AI SDK format at their source, not in the registry.
 */

import log from '../logger';
import { getRemoteMCPManager } from '../mcp/manager';
import { convertMCPToAISDKTool } from '../mcp/tool-bridge';
import { convertWebMCPToAISDKTool } from './tool-bridge';
import { ConfigStorage } from '../storage/config'; // Still needed for remote MCP tools
import { fetchUrlTool, FETCH_URL_TOOL_NAME } from './tools/fetch';
import { calculateSpecificityScore } from './tool-patterns';

export type ToolSourceType = 'site' | 'user' | 'remote' | 'system';
// AI SDK tool type - both MCP and WebMCP converters return the same shape
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AISDKTool = any; // The actual tool type from AI SDK

export interface ToolWithMetadata {
  tool: AISDKTool;
  source: ToolSourceType;
  origin?: string; // URL for site tools, script ID for user tools, server name for remote tools
}

/**
 * Manages unified tool registry across all sources
 */
export class ToolRegistryManager {
  private tools = new Map<string, ToolWithMetadata>();
  private listeners = new Set<(tools: Record<string, AISDKTool>) => void>();

  /**
   * Register system tools on initialization
   * System tools are global (not tab-specific) and execute in background worker
   * They have elevated privileges (e.g., CORS-free fetching)
   *
   * Must be called explicitly after construction (constructors can't be async)
   * Respects user enable/disable preferences (default: enabled)
   */
  async registerSystemTools(): Promise<void> {
    // Check if system tool is enabled (default: true)
    const configStorage = ConfigStorage.getInstance();
    const isEnabled = await configStorage.isBuiltinToolEnabled(FETCH_URL_TOOL_NAME);

    if (!isEnabled) {
      log.info('[ToolRegistry] System tool disabled by user:', FETCH_URL_TOOL_NAME);
      return;
    }

    // Register fetch URL tool (already pre-converted to AI SDK format)
    this.addTool(FETCH_URL_TOOL_NAME, {
      tool: fetchUrlTool,
      source: 'system',
      origin: 'system',
    });

    log.info('[ToolRegistry] Registered system tools:', [FETCH_URL_TOOL_NAME]);
  }

  /**
   * Add or update a tool in the registry
   */
  addTool(name: string, toolWithMeta: ToolWithMetadata): void {
    this.tools.set(name, toolWithMeta);
    this.notifyListeners();

    log.warn(
      `[ToolRegistry] Added tool ${name} (${toolWithMeta.source}) from ${toolWithMeta.origin || 'unknown'}`
    );
  }

  /**
   * Remove a tool from the registry
   */
  removeTool(name: string): void {
    if (this.tools.delete(name)) {
      this.notifyListeners();
      log.warn(`[ToolRegistry] Removed tool ${name}`);
    }
  }

  /**
   * Remove all tools from a specific origin
   */
  removeToolsByOrigin(origin: string): void {
    const toRemove: string[] = [];
    for (const [name, meta] of this.tools.entries()) {
      if (meta.origin === origin) {
        toRemove.push(name);
      }
    }

    for (const name of toRemove) {
      this.tools.delete(name);
    }

    if (toRemove.length > 0) {
      this.notifyListeners();
      log.warn(`[ToolRegistry] Removed ${toRemove.length} tools from origin ${origin}`);
    }
  }

  /**
   * Collect, score, and sort tools by specificity.
   * Returns tools as Record (ordered by score descending) plus debug info.
   */
  private getToolsSortedBySpecificity(filter?: (name: string, meta: ToolWithMetadata) => boolean): {
    tools: Record<string, AISDKTool>;
    debug: string[];
  } {
    const scored: Array<[string, AISDKTool, number]> = [];

    for (const [name, meta] of this.tools.entries()) {
      if (!filter || filter(name, meta)) {
        scored.push([name, meta.tool, calculateSpecificityScore(name, meta.source)]);
      }
    }

    scored.sort((a, b) => b[2] - a[2]);

    return {
      tools: Object.fromEntries(scored.map(([name, tool]) => [name, tool])),
      debug: scored.map(([name, , score]) => `${name}:${score}`),
    };
  }

  /**
   * Get all tools as a record for AI SDK consumption
   * Ordered by specificity score (descending)
   */
  getAllTools(): Record<string, AISDKTool> {
    const { tools, debug } = this.getToolsSortedBySpecificity();
    log.info(`[ToolRegistry] Providing ${debug.length} tools (all):`, debug);
    return tools;
  }

  /**
   * Get tools scoped to a specific tab (for tab-specific sidebars)
   * Includes both tab-specific tools AND global tools (remote, system)
   *
   * Tool Ordering: Tools are sorted by specificity score (descending).
   * Higher scores appear first, leveraging LLM positional bias.
   * See tool-patterns.ts for scoring logic.
   */
  getToolsForTab(tabId: number): Record<string, AISDKTool> {
    const { tools, debug } = this.getToolsSortedBySpecificity(
      (_, meta) =>
        meta.origin === `tab-${tabId}` || meta.source === 'remote' || meta.source === 'system'
    );
    log.info(`[ToolRegistry] Providing ${debug.length} tools for tab ${tabId}:`, debug);
    return tools;
  }

  /**
   * Register a listener for tool changes
   */
  addListener(listener: (tools: Record<string, AISDKTool>) => void): void {
    this.listeners.add(listener);
  }

  /**
   * Remove a listener
   */
  removeListener(listener: (tools: Record<string, AISDKTool>) => void): void {
    this.listeners.delete(listener);
  }

  /**
   * Clear all tools
   */
  reset(): void {
    this.tools.clear();
    this.notifyListeners();
  }

  /**
   * Notify all listeners of tool changes
   */
  private notifyListeners(): void {
    const tools = this.getAllTools();
    for (const listener of this.listeners) {
      try {
        listener(tools);
      } catch (error) {
        log.error('[ToolRegistry] Error in listener:', error);
      }
    }
  }

  /**
   * Load remote MCP server tools
   */
  async loadRemoteTools(): Promise<void> {
    try {
      // First, remove any existing remote tools
      const remoteTools: string[] = [];
      for (const [name, meta] of this.tools.entries()) {
        if (meta.source === 'remote') {
          remoteTools.push(name);
        }
      }
      for (const name of remoteTools) {
        this.tools.delete(name);
      }

      // Get current config and ensure MCP manager is connected
      const configStorage = ConfigStorage.getInstance();
      const config = await configStorage.get();

      if (!config?.mcpConfig?.mcpServers || Object.keys(config.mcpConfig.mcpServers).length === 0) {
        log.warn('[ToolRegistry] No MCP servers configured');
        return;
      }

      // Load the configuration into Remote MCP manager (connects to servers)
      const remoteMCPManager = getRemoteMCPManager();
      await remoteMCPManager.loadConfig(config.mcpConfig);

      // Now get the available tools
      const mcpTools = remoteMCPManager.getAvailableTools();

      // Convert and add each tool
      for (const mcpTool of mcpTools) {
        // Get the server name for this tool
        const serverStatuses = remoteMCPManager.getServerStatuses();
        let serverName = 'unknown';

        // Find which server has this tool
        for (const status of serverStatuses) {
          if (status.tools.some((t) => t.name === mcpTool.name)) {
            serverName = status.name;
            break;
          }
        }

        const aiTool = convertMCPToAISDKTool(mcpTool, serverName);
        this.addTool(mcpTool.name, {
          tool: aiTool,
          source: 'remote',
          origin: serverName,
        });
      }

      log.warn(`[ToolRegistry] Loaded ${mcpTools.length} remote MCP tools`);
    } catch (error) {
      log.error('[ToolRegistry] Error loading remote MCP tools:', error);
    }
  }

  /**
   * Update tools from a WebMCP page context (site tools and user scripts)
   */
  updateWebMCPTools(
    tabId: number,
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
    }>,
    origin: string
  ): void {
    // Remove existing tools from this tab
    this.removeToolsByOrigin(`tab-${tabId}`);

    // Convert and add each WebMCP tool
    for (const webmcpTool of tools) {
      const aiTool = convertWebMCPToAISDKTool(webmcpTool, tabId);

      this.addTool(webmcpTool.name, {
        tool: aiTool,
        source: 'site', // Both site and user tools come through as 'site' for now
        origin: `tab-${tabId}`,
      });
    }

    log.warn(
      `[ToolRegistry] Added ${tools.length} WebMCP tools from tab ${tabId} (${origin}):`,
      tools.map((t) => t.name)
    );
  }
}

// Singleton instance
let registryInstance: ToolRegistryManager | null = null;

export function getToolRegistry(): ToolRegistryManager {
  if (!registryInstance) {
    registryInstance = new ToolRegistryManager();
  }
  return registryInstance;
}
