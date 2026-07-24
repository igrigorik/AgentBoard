/**
 * Tests for MCP server instructions propagation
 * Verifies instructions flow from SDK client → MCPClientService → RemoteMCPManager → system prompt
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mock MCP SDK Client ---
const mockGetInstructions = vi.fn<() => string | undefined>();
const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockListTools = vi.fn();
const mockCallTool = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
    listTools: mockListTools,
    callTool: mockCallTool,
    getInstructions: mockGetInstructions,
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

// --- Import after mocks ---
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { MCPClientService } from '../src/lib/mcp/client';
import { RemoteMCPManager } from '../src/lib/mcp/manager';

describe('MCP Server Instructions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockGetInstructions.mockReturnValue(undefined);
  });

  describe('MCPClientService', () => {
    it('configures the SDK with a CSP-safe JSON Schema validator', async () => {
      const client = new MCPClientService();
      await client.connect(
        { url: 'http://localhost:3000/mcp', transport: 'http' as const },
        'test-server'
      );

      expect(Client).toHaveBeenCalledWith(
        {
          name: 'chrome-extension-client',
          version: '1.0.0',
        },
        {
          capabilities: {},
          jsonSchemaValidator: expect.any(CfWorkerJsonSchemaValidator),
        }
      );
    });

    it('closes and resets a partially connected client when initial discovery fails', async () => {
      mockListTools.mockRejectedValueOnce(new Error('secret discovery failure'));
      const client = new MCPClientService();

      const status = await client.connect(
        { url: 'http://localhost:3000/mcp', transport: 'http' as const },
        'test-server'
      );

      expect(status).toEqual({
        connected: false,
        serverName: 'test-server',
        error: 'Connection failed',
      });
      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(client.isConnected()).toBe(false);
      expect(client.getServerConfig()).toBeNull();
      expect(JSON.stringify(status)).not.toContain('secret discovery failure');
    });

    it('forwards an abort signal to MCP SDK tool calls', async () => {
      mockCallTool.mockResolvedValue({
        isError: false,
        content: [{ type: 'text', text: 'ok' }],
      });
      const client = new MCPClientService();
      await client.connect(
        { url: 'http://localhost:3000/mcp', transport: 'http' as const },
        'test-server'
      );
      const controller = new AbortController();

      await client.callTool('query', { value: 1 }, controller.signal);

      expect(mockCallTool).toHaveBeenCalledWith(
        { name: 'query', arguments: { value: 1 } },
        undefined,
        { signal: controller.signal }
      );
    });

    it('should capture instructions from server when present', async () => {
      mockGetInstructions.mockReturnValue('Always call search before get.');
      mockListTools.mockResolvedValue({
        tools: [{ name: 'search', description: 'Search docs' }],
      });

      const client = new MCPClientService();
      const status = await client.connect(
        { url: 'http://localhost:3000/mcp', transport: 'http' as const },
        'test-server'
      );

      expect(status.connected).toBe(true);
      expect(status.instructions).toBe('Always call search before get.');
    });

    it('should omit instructions field when server provides none', async () => {
      mockGetInstructions.mockReturnValue(undefined);
      mockListTools.mockResolvedValue({ tools: [] });

      const client = new MCPClientService();
      const status = await client.connect(
        { url: 'http://localhost:3000/mcp', transport: 'http' as const },
        'test-server'
      );

      expect(status.connected).toBe(true);
      expect(status.instructions).toBeUndefined();
    });

    it('should not include instructions when connection fails', async () => {
      mockConnect.mockRejectedValueOnce(new Error('Connection refused'));

      const client = new MCPClientService();
      const status = await client.connect(
        { url: 'http://bad:3000/mcp', transport: 'http' as const },
        'bad-server'
      );

      expect(status.connected).toBe(false);
      expect(status.instructions).toBeUndefined();
    });
  });

  describe('RemoteMCPManager', () => {
    let manager: RemoteMCPManager;

    beforeEach(() => {
      manager = new RemoteMCPManager();
    });

    afterEach(async () => {
      await manager.disconnectAll();
    });

    it('forwards stream cancellation through the captured session capability', async () => {
      mockListTools.mockResolvedValue({ tools: [{ name: 'query', description: 'Query data' }] });
      mockCallTool.mockResolvedValue({
        isError: false,
        content: [{ type: 'text', text: 'ok' }],
      });
      await manager.reconcile({
        mcpServers: {
          'data-api': { url: 'http://localhost:3000/mcp', transport: 'http' as const },
        },
      });
      const session = manager.getCurrentSession();
      const [capability] = session.getToolCapabilities();
      const controller = new AbortController();

      expect(session.signal.aborted).toBe(false);
      expect(capability).toBeDefined();
      await session.executeTool(capability, { value: 1 }, controller.signal);

      expect(mockCallTool).toHaveBeenCalledWith(
        { name: 'query', arguments: { value: 1 } },
        undefined,
        { signal: expect.any(AbortSignal) }
      );
    });

    it('surfaces instructions in status and the same published session snapshot', async () => {
      mockGetInstructions.mockReturnValue('Use format=json for structured output.');
      mockListTools.mockResolvedValue({
        tools: [{ name: 'query', description: 'Query data' }],
      });

      const statuses = await manager.reconcile({
        mcpServers: {
          'data-api': { url: 'http://localhost:3000/mcp', transport: 'http' as const },
        },
      });
      const session = manager.getCurrentSession();

      expect(statuses).toEqual([
        expect.objectContaining({
          name: 'data-api',
          status: 'connected',
          instructions: 'Use format=json for structured output.',
        }),
      ]);
      expect(session.getServerStatuses()).toEqual(statuses);
      expect(session.getMCPInstructions()).toContain('Use format=json for structured output.');
      expect(session.getToolCapabilities()[0].tool.name).toBe('query');
    });

    it('aggregates instructions from connected servers and skips missing instructions', async () => {
      let callCount = 0;
      mockGetInstructions.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? 'Server A: call search first.' : undefined;
      });
      mockListTools.mockResolvedValue({ tools: [] });

      await manager.reconcile({
        mcpServers: {
          'server-a': { url: 'http://localhost:3001/mcp', transport: 'http' as const },
          'server-b': { url: 'http://localhost:3002/mcp', transport: 'http' as const },
        },
      });

      const instructions = manager.getCurrentSession().getMCPInstructions();
      expect(instructions).toContain('# MCP Server Instructions');
      expect(instructions).toContain('## MCP Server: server-a');
      expect(instructions).not.toContain('server-b');
    });

    it('publishes no instructions when servers provide none', async () => {
      mockGetInstructions.mockReturnValue(undefined);
      mockListTools.mockResolvedValue({ tools: [] });

      await manager.reconcile({
        mcpServers: {
          empty: { url: 'http://localhost:3000/mcp', transport: 'http' as const },
        },
      });

      expect(manager.getCurrentSession().getMCPInstructions()).toBeUndefined();
    });

    it('clears the published snapshot before disconnect cleanup settles', async () => {
      mockGetInstructions.mockReturnValue('Temporary instructions.');
      mockListTools.mockResolvedValue({ tools: [] });
      await manager.reconcile({
        mcpServers: {
          temp: { url: 'http://localhost:3000/mcp', transport: 'http' as const },
        },
      });
      const previous = manager.getCurrentSession();

      const cleanup = manager.disconnectAll();

      expect(previous.signal.aborted).toBe(true);
      expect(manager.getCurrentSession().getMCPInstructions()).toBeUndefined();
      await cleanup;
    });
  });
});
