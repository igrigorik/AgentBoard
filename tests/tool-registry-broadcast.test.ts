/**
 * Unit tests for ToolRegistry broadcast functionality
 * Tests that tool registry changes are broadcast to sidebars via chrome.runtime.sendMessage
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistryManager } from '../src/lib/webmcp/tool-registry';

// Mock chrome API
const mockChrome = {
  runtime: {
    sendMessage: vi.fn(),
  },
  storage: {
    local: {
      get: vi.fn(),
      set: vi.fn(),
    },
  },
};

(globalThis as any).chrome = mockChrome;

describe('ToolRegistry Broadcast', () => {
  let registry: ToolRegistryManager;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ToolRegistryManager();

    // Mock sendMessage to resolve successfully (sidebar is listening)
    mockChrome.runtime.sendMessage.mockResolvedValue({ received: true });
  });

  it('should broadcast TOOLS_UPDATED when a tool is added', async () => {
    const testTool = {
      tool: { name: 'test_tool', description: 'Test tool' },
      source: 'site' as const,
      origin: 'tab-123',
    };

    registry.addTool('test_tool', testTool);

    // Wait for async sendMessage
    await vi.waitFor(() => {
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TOOLS_UPDATED',
          timestamp: expect.any(Number),
        })
      );
    });
  });

  it('should broadcast TOOLS_UPDATED when a tool is removed', async () => {
    const testTool = {
      tool: { name: 'test_tool', description: 'Test tool' },
      source: 'site' as const,
      origin: 'tab-123',
    };

    registry.addTool('test_tool', testTool);
    vi.clearAllMocks(); // Clear the add broadcast

    registry.removeTool('test_tool');

    await vi.waitFor(() => {
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TOOLS_UPDATED',
          timestamp: expect.any(Number),
        })
      );
    });
  });

  it('should broadcast TOOLS_UPDATED when tools are removed by origin', async () => {
    const tool1 = {
      tool: { name: 'tool1', description: 'Tool 1' },
      source: 'site' as const,
      origin: 'tab-123',
    };
    const tool2 = {
      tool: { name: 'tool2', description: 'Tool 2' },
      source: 'site' as const,
      origin: 'tab-123',
    };

    registry.addTool('tool1', tool1);
    registry.addTool('tool2', tool2);
    vi.clearAllMocks();

    registry.removeToolsByOrigin('tab-123');

    await vi.waitFor(() => {
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TOOLS_UPDATED',
          timestamp: expect.any(Number),
        })
      );
    });
  });

  it('should broadcast TOOLS_UPDATED when WebMCP tools are updated', async () => {
    const webmcpTools = [
      { name: 'webmcp_tool1', description: 'WebMCP Tool 1' },
      { name: 'webmcp_tool2', description: 'WebMCP Tool 2' },
    ];

    registry.updateWebMCPTools(456, webmcpTools, 'https://example.com');

    await vi.waitFor(() => {
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TOOLS_UPDATED',
          timestamp: expect.any(Number),
        })
      );
    });
  });

  it('should not throw error if no sidebar is listening', async () => {
    // Mock sendMessage to reject (no sidebar listening)
    mockChrome.runtime.sendMessage.mockRejectedValue(
      new Error('Could not establish connection. Receiving end does not exist.')
    );

    const testTool = {
      tool: { name: 'test_tool', description: 'Test tool' },
      source: 'site' as const,
      origin: 'tab-123',
    };

    // Should not throw
    expect(() => {
      registry.addTool('test_tool', testTool);
    }).not.toThrow();

    // Should still attempt to send
    await vi.waitFor(() => {
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalled();
    });
  });

  it('should broadcast with correct timestamp', async () => {
    const beforeTimestamp = Date.now();

    const testTool = {
      tool: { name: 'test_tool', description: 'Test tool' },
      source: 'site' as const,
      origin: 'tab-123',
    };

    registry.addTool('test_tool', testTool);

    await vi.waitFor(() => {
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalled();
    });

    const afterTimestamp = Date.now();
    const call = mockChrome.runtime.sendMessage.mock.calls[0][0];

    expect(call.timestamp).toBeGreaterThanOrEqual(beforeTimestamp);
    expect(call.timestamp).toBeLessThanOrEqual(afterTimestamp);
  });

  it('should still notify in-process listeners when broadcasting', async () => {
    const listener = vi.fn();
    registry.addListener(listener);

    const testTool = {
      tool: { name: 'test_tool', description: 'Test tool' },
      source: 'site' as const,
      origin: 'tab-123',
    };

    registry.addTool('test_tool', testTool);

    // In-process listener should be called immediately
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        test_tool: expect.any(Object),
      })
    );

    // And message should still be broadcast
    await vi.waitFor(() => {
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalled();
    });
  });

  it('should broadcast for each tool addition in updateWebMCPTools', async () => {
    const tools = [
      { name: 'tool1', description: 'Tool 1' },
      { name: 'tool2', description: 'Tool 2' },
      { name: 'tool3', description: 'Tool 3' },
    ];

    // updateWebMCPTools adds multiple tools individually
    // Each addTool call triggers a broadcast
    registry.updateWebMCPTools(789, tools, 'https://example.com');

    await vi.waitFor(() => {
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalled();
    });

    // Should be called 3 times - once per tool addition
    expect(mockChrome.runtime.sendMessage).toHaveBeenCalledTimes(3);
  });
});
