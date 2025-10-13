/**
 * MCP Client Service - Wrapper around the MCP SDK Client
 * Handles individual server connections using the SDK's built-in client
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool, CallToolResult, Resource } from '@modelcontextprotocol/sdk/types.js';
import log from '../logger';
import type { MCPServerConfig } from '../storage/config';

export interface MCPClientStatus {
  connected: boolean;
  serverName: string;
  error?: string;
  tools?: Tool[];
}

/**
 * Wrapper around MCP SDK Client for Chrome extension usage
 * Each instance manages connection to a single MCP server
 */
export class MCPClientService {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private serverConfig: MCPServerConfig | null = null;
  private connected = false;

  /**
   * Connect to an MCP server using StreamableHTTP transport
   */
  async connect(serverConfig: MCPServerConfig, serverName?: string): Promise<MCPClientStatus> {
    try {
      this.serverConfig = serverConfig;

      // Create StreamableHTTP transport with optional auth header
      const requestInit: RequestInit = {};
      if (serverConfig.authToken) {
        requestInit.headers = {
          Authorization: `Bearer ${serverConfig.authToken}`,
        };
      }

      this.transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
        requestInit,
      });

      // Create and connect client with required capabilities
      this.client = new Client(
        {
          name: 'chrome-extension-client',
          version: '1.0.0',
        },
        {
          capabilities: {}, // Add capabilities as needed
        }
      );

      await this.client.connect(this.transport);
      this.connected = true;

      // Fetch available tools immediately after connection
      const toolsList = await this.listTools();

      return {
        connected: true,
        serverName: serverName || 'unknown',
        tools: toolsList,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown connection error';
      log.error(`Failed to connect to MCP server ${serverName}:`, error);

      return {
        connected: false,
        serverName: serverName || 'unknown',
        error: errorMessage,
      };
    }
  }

  /**
   * List available tools from the connected server
   */
  async listTools(): Promise<Tool[]> {
    if (!this.client || !this.connected) {
      throw new Error('Client not connected');
    }

    try {
      const response = await this.client.listTools();
      return response.tools;
    } catch (error) {
      log.error('Failed to list tools:', error);
      throw error;
    }
  }

  /**
   * Call a tool on the connected server
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.client || !this.connected) {
      throw new Error('Client not connected');
    }

    const toolCallPayload = {
      name,
      arguments: args || {}, // Ensure arguments is always an object
    };

    try {
      const result = await this.client.callTool(toolCallPayload);
      return result as CallToolResult;
    } catch (error) {
      log.error(`Failed to call tool ${name}:`, error);
      throw error;
    }
  }

  /**
   * List available resources (if server supports them)
   */
  async listResources(): Promise<Resource[]> {
    if (!this.client || !this.connected) {
      throw new Error('Client not connected');
    }

    try {
      const response = await this.client.listResources();
      return response.resources;
    } catch (error) {
      // Resources might not be supported by all servers
      log.warn('Failed to list resources (may not be supported):', error);
      return [];
    }
  }

  /**
   * Disconnect from the server
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch (error) {
        log.error('Error closing client:', error);
      }
      this.client = null;
    }

    this.transport = null;
    this.connected = false;
    this.serverConfig = null;
  }

  /**
   * Check if client is connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get server configuration
   */
  getServerConfig(): MCPServerConfig | null {
    return this.serverConfig;
  }
}
