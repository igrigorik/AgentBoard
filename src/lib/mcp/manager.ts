/**
 * MCP (Model Context Protocol) manager
 * Orchestrates multiple MCP client connections and aggregates tools
 */

import log from '../logger';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MCPClientService } from './client';
import type { MCPConfig, MCPServerConfig } from '../storage/config';

export interface MCPServerStatus {
  name: string;
  status: 'connected' | 'disconnected' | 'error';
  error?: string;
  tools: Array<{
    name: string;
    description?: string;
  }>;
}

export interface MCPToolExecution {
  toolName: string;
  serverName: string;
  input: Record<string, unknown>;
  output?: unknown;
  error?: Error;
}

/**
 * Remote MCP Manager - Manages connections to external MCP servers
 * Aggregates tools from multiple remote servers
 */
export class RemoteMCPManager {
  private clients: Map<string, MCPClientService> = new Map();
  private serverTools: Map<string, Tool[]> = new Map();
  private config: MCPConfig | null = null;

  /**
   * Load and connect to all servers in the configuration
   * Returns status for each server including available tools
   */
  async loadConfig(config: MCPConfig): Promise<MCPServerStatus[]> {
    const serverCount = Object.keys(config.mcpServers).length;
    log.info('📡 [RemoteMCPManager] Loading MCP configuration with', serverCount, 'servers');
    this.config = config;

    // Disconnect existing clients
    await this.disconnectAll();

    const statuses: MCPServerStatus[] = [];

    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      log.info('📡 [RemoteMCPManager] Connecting to server:', name, 'at', serverConfig.url);
      const status = await this.connectServer(name, serverConfig);
      log.info('📡 [RemoteMCPManager] Server status:', status);
      statuses.push(status);
    }

    log.info(
      '📡 [RemoteMCPManager] All servers loaded. Connected:',
      statuses.filter((s) => s.status === 'connected').length
    );
    return statuses;
  }

  /**
   * Connect to a single MCP server
   */
  private async connectServer(
    name: string,
    serverConfig: MCPServerConfig
  ): Promise<MCPServerStatus> {
    const client = new MCPClientService();

    try {
      const connectionStatus = await client.connect(serverConfig, name);

      if (connectionStatus.connected && connectionStatus.tools) {
        // Store client and tools
        this.clients.set(name, client);
        this.serverTools.set(name, connectionStatus.tools);

        return {
          name,
          status: 'connected',
          tools: connectionStatus.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
          })),
        };
      } else {
        return {
          name,
          status: 'error',
          error: connectionStatus.error || 'Failed to connect',
          tools: [],
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      return {
        name,
        status: 'error',
        error: errorMessage,
        tools: [],
      };
    }
  }

  /**
   * Get merged list of all available tools from connected servers
   * Tools are deduplicated by name, with first server taking priority
   */
  getAvailableTools(): Tool[] {
    const toolMap = new Map<string, Tool>();

    // Merge tools from all connected servers
    for (const [serverName, tools] of this.serverTools) {
      const client = this.clients.get(serverName);
      if (client?.isConnected()) {
        for (const tool of tools) {
          // First server wins for duplicate tool names
          if (!toolMap.has(tool.name)) {
            toolMap.set(tool.name, tool);
          }
        }
      }
    }

    return Array.from(toolMap.values());
  }

  /**
   * Execute a tool, routing to the appropriate server
   * Tries servers in order until one has the tool
   */
  async executeTool(execution: MCPToolExecution): Promise<CallToolResult> {
    log.info('🎯 [RemoteMCPManager] Executing tool:', {
      tool: execution.toolName,
      server: execution.serverName,
      input: execution.input,
    });

    const startTime = Date.now();

    // First try the specified server if provided
    if (execution.serverName) {
      const client = this.clients.get(execution.serverName);
      if (client?.isConnected()) {
        try {
          const result = await client.callTool(execution.toolName, execution.input);
          const duration = Date.now() - startTime;

          log.info('✅ [RemoteMCPManager] Tool execution complete:', {
            tool: execution.toolName,
            server: execution.serverName,
            duration: `${duration}ms`,
            resultType: typeof result,
          });

          return result;
        } catch (error) {
          log.error(`Tool execution failed on ${execution.serverName}:`, error);
          throw error;
        }
      } else {
        throw new Error(`Server '${execution.serverName}' is not connected`);
      }
    }

    // Otherwise, find a server that has this tool
    for (const [serverName, tools] of this.serverTools) {
      const hassTool = tools.some((t) => t.name === execution.toolName);
      if (hassTool) {
        const client = this.clients.get(serverName);
        if (client?.isConnected()) {
          try {
            return await client.callTool(execution.toolName, execution.input);
          } catch (error) {
            log.error(`Tool execution failed on ${serverName}:`, error);
            // Continue to try other servers
          }
        }
      }
    }

    throw new Error(`No connected server found with tool '${execution.toolName}'`);
  }

  /**
   * Get current status of all configured servers
   */
  getServerStatuses(): MCPServerStatus[] {
    const statuses: MCPServerStatus[] = [];

    if (!this.config) {
      return statuses;
    }

    for (const [name] of Object.entries(this.config.mcpServers)) {
      const client = this.clients.get(name);
      const tools = this.serverTools.get(name) || [];

      if (client?.isConnected()) {
        statuses.push({
          name,
          status: 'connected',
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
          })),
        });
      } else {
        statuses.push({
          name,
          status: 'disconnected',
          tools: [],
        });
      }
    }

    return statuses;
  }

  /**
   * Refresh connections for all servers
   */
  async refreshStatuses(): Promise<MCPServerStatus[]> {
    if (!this.config) {
      return [];
    }
    return this.loadConfig(this.config);
  }

  /**
   * Disconnect all clients
   */
  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.disconnect();
    }
    this.clients.clear();
    this.serverTools.clear();
  }

  /**
   * Get tools for AI SDK integration
   * Returns tools in a format ready for the AI SDK
   */
  async getAISDKTools() {
    // Import dynamically to avoid circular dependencies
    const { getMCPToolsForAISDK } = await import('./tool-bridge');
    return getMCPToolsForAISDK();
  }
}

// Singleton instance
let remoteMCPManagerInstance: RemoteMCPManager | null = null;

export function getRemoteMCPManager(): RemoteMCPManager {
  if (!remoteMCPManagerInstance) {
    remoteMCPManagerInstance = new RemoteMCPManager();
  }
  return remoteMCPManagerInstance;
}
