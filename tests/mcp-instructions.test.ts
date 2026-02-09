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

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
    listTools: mockListTools.mockResolvedValue({ tools: [] }),
    getInstructions: mockGetInstructions,
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

// --- Import after mocks ---
import { MCPClientService } from '../src/lib/mcp/client';
import { RemoteMCPManager } from '../src/lib/mcp/manager';

describe('MCP Server Instructions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('MCPClientService', () => {
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

    it('should surface instructions in server status', async () => {
      mockGetInstructions.mockReturnValue('Use format=json for structured output.');
      mockListTools.mockResolvedValue({
        tools: [{ name: 'query', description: 'Query data' }],
      });

      const statuses = await manager.loadConfig({
        mcpServers: {
          'data-api': { url: 'http://localhost:3000/mcp', transport: 'http' as const },
        },
      });

      expect(statuses).toHaveLength(1);
      expect(statuses[0].status).toBe('connected');
      expect(statuses[0].instructions).toBe('Use format=json for structured output.');
    });

    it('should include instructions in getServerStatuses()', async () => {
      mockGetInstructions.mockReturnValue('Always paginate results.');
      mockListTools.mockResolvedValue({ tools: [] });

      await manager.loadConfig({
        mcpServers: {
          paginator: { url: 'http://localhost:3000/mcp', transport: 'http' as const },
        },
      });

      const statuses = manager.getServerStatuses();
      expect(statuses[0].instructions).toBe('Always paginate results.');
    });

    it('should aggregate instructions from multiple servers', async () => {
      let callCount = 0;
      mockGetInstructions.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? 'Server A: call search first.' : 'Server B: use batch mode.';
      });
      mockListTools.mockResolvedValue({ tools: [] });

      await manager.loadConfig({
        mcpServers: {
          'server-a': { url: 'http://localhost:3001/mcp', transport: 'http' as const },
          'server-b': { url: 'http://localhost:3002/mcp', transport: 'http' as const },
        },
      });

      const instructions = manager.getMCPInstructions();
      expect(instructions).toContain('# MCP Server Instructions');
      expect(instructions).toContain('## MCP Server: server-a');
      expect(instructions).toContain('Server A: call search first.');
      expect(instructions).toContain('## MCP Server: server-b');
      expect(instructions).toContain('Server B: use batch mode.');
    });

    it('should return undefined when no server has instructions', async () => {
      mockGetInstructions.mockReturnValue(undefined);
      mockListTools.mockResolvedValue({ tools: [] });

      await manager.loadConfig({
        mcpServers: {
          'no-instructions': { url: 'http://localhost:3000/mcp', transport: 'http' as const },
        },
      });

      expect(manager.getMCPInstructions()).toBeUndefined();
    });

    it('should only include instructions from connected servers', async () => {
      mockGetInstructions.mockReturnValue('Should not appear.');
      mockListTools.mockResolvedValue({ tools: [] });

      await manager.loadConfig({
        mcpServers: {
          ephemeral: { url: 'http://localhost:3000/mcp', transport: 'http' as const },
        },
      });

      // Disconnect the server
      await manager.disconnectAll();

      expect(manager.getMCPInstructions()).toBeUndefined();
    });

    it('should clear instructions on disconnectAll', async () => {
      mockGetInstructions.mockReturnValue('Temporary instructions.');
      mockListTools.mockResolvedValue({ tools: [] });

      await manager.loadConfig({
        mcpServers: {
          temp: { url: 'http://localhost:3000/mcp', transport: 'http' as const },
        },
      });

      expect(manager.getMCPInstructions()).toBeDefined();

      await manager.disconnectAll();

      expect(manager.getMCPInstructions()).toBeUndefined();
    });

    it('should skip servers without instructions in aggregation', async () => {
      let callCount = 0;
      mockGetInstructions.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? 'Only server-a has instructions.' : undefined;
      });
      mockListTools.mockResolvedValue({ tools: [] });

      await manager.loadConfig({
        mcpServers: {
          'server-a': { url: 'http://localhost:3001/mcp', transport: 'http' as const },
          'server-b': { url: 'http://localhost:3002/mcp', transport: 'http' as const },
        },
      });

      const instructions = manager.getMCPInstructions();
      expect(instructions).toContain('server-a');
      expect(instructions).not.toContain('server-b');
    });
  });
});
