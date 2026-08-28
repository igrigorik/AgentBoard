/**
 * MCP Client Service - Wrapper around the MCP SDK Client
 * Handles individual server connections using the SDK's built-in client
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import type { Tool, CallToolResult, Resource } from '@modelcontextprotocol/sdk/types.js';
import log from '../logger';
import type { MCPServerConfig } from '../storage/config';

/**
 * Discovery must not stall a user's message. The SDK default is 60s and
 * RemoteMCPSession connects servers sequentially, so a black-holed server would
 * otherwise hold up first token by 60s per server. Tool *calls* are deliberately
 * left on the default: a slow tool is doing work, not failing to answer.
 */
export const MCP_DISCOVERY_TIMEOUT_MS = 5_000;

export interface MCPClientStatus {
  connected: boolean;
  serverName: string;
  error?: string;
  tools?: Tool[];
  instructions?: string;
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
          // The SDK's Ajv default uses new Function(), which extension CSP forbids.
          jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
        }
      );

      await this.client.connect(this.transport, { timeout: MCP_DISCOVERY_TIMEOUT_MS });
      this.connected = true;

      // Fetch available tools immediately after connection
      const toolsList = await this.listTools();

      // Extract server instructions (guidance for LLMs on how to use tools)
      const instructions = this.client.getInstructions();

      return {
        connected: true,
        serverName: serverName || 'unknown',
        tools: toolsList,
        ...(instructions && { instructions }),
      };
    } catch {
      log.error('MCP server connection failed');
      await this.disconnect();

      return {
        connected: false,
        serverName: serverName || 'unknown',
        error: 'Connection failed',
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
      const response = await this.client.listTools(undefined, {
        timeout: MCP_DISCOVERY_TIMEOUT_MS,
      });
      return response.tools;
    } catch (error) {
      log.error('MCP tool discovery failed');
      throw error;
    }
  }

  /**
   * Call a tool on the connected server
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<CallToolResult> {
    if (!this.client || !this.connected) {
      throw new Error('Client not connected');
    }

    const toolCallPayload = {
      name,
      arguments: args || {}, // Ensure arguments is always an object
    };

    try {
      const result = await this.client.callTool(toolCallPayload, undefined, { signal });
      return result as CallToolResult;
    } catch (error) {
      log.error('MCP tool execution failed');
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
    } catch {
      // Resources might not be supported by all servers
      log.warn('MCP resource discovery failed');
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
      } catch {
        log.error('MCP client close failed');
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
