/**
 * Basic integration tests for WebMCP
 * Tests actual TabManager behavior
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TabManager } from '../../src/lib/webmcp/lifecycle';

describe('WebMCP Basic Integration', () => {
  let mockChrome: any;
  let lifecycleManager: TabManager;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup minimal Chrome mock
    mockChrome = {
      runtime: {
        onConnect: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() },
        sendMessage: vi.fn().mockImplementation(() => Promise.resolve()),
        lastError: null,
      },
      webNavigation: {
        onBeforeNavigate: { addListener: vi.fn() },
        onDOMContentLoaded: { addListener: vi.fn() },
      },
      tabs: {
        onRemoved: { addListener: vi.fn() },
        get: vi.fn(),
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue(undefined),
      },
    };

    // Mock crypto for UUID generation
    if (!globalThis.crypto) {
      Object.defineProperty(globalThis, 'crypto', {
        value: {
          randomUUID: () => `test-uuid-${Math.random()}`,
        },
        writable: true,
        configurable: true,
      });
    } else {
      vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
        () => `test-uuid-${Math.random()}` as `${string}-${string}-${string}-${string}-${string}`
      );
    }

    // Setup Chrome global
    (global as any).chrome = mockChrome;

    // Create lifecycle manager
    lifecycleManager = new TabManager();
  });

  it('should handle port connections', () => {
    const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];
    expect(onConnectHandler).toBeDefined();

    const mockPort = {
      name: 'webmcp-content-script',
      sender: { tab: { id: 123 } },
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };

    // Connect port
    onConnectHandler(mockPort);

    // Verify port handlers were registered
    expect(mockPort.onMessage.addListener).toHaveBeenCalled();
    expect(mockPort.onDisconnect.addListener).toHaveBeenCalled();
  });

  it('should store tool registry when tools are registered', () => {
    const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];

    const mockPort = {
      name: 'webmcp-content-script',
      sender: { tab: { id: 123 } },
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };

    let messageHandler: Function | null = null;
    mockPort.onMessage.addListener.mockImplementation((handler) => {
      messageHandler = handler;
    });

    onConnectHandler(mockPort);

    // Send tools/listChanged
    if (messageHandler) {
      (messageHandler as Function)({
        type: 'webmcp',
        payload: {
          method: 'tools/listChanged',
          params: {
            tools: [
              { name: 'tool1', description: 'First tool' },
              { name: 'tool2', description: 'Second tool' },
            ],
            origin: 'https://example.com',
          },
        },
      });
    }

    // Verify tools are stored
    const registry = lifecycleManager.getToolRegistry(123);
    expect(registry).toBeDefined();
    expect(registry?.tools).toHaveLength(2);
    expect(registry?.origin).toBe('https://example.com');
  });

  it('should send tool calls to content script', async () => {
    const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];

    const mockPort = {
      name: 'webmcp-content-script',
      sender: { tab: { id: 123 } },
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };

    let messageHandler: Function | null = null;
    mockPort.onMessage.addListener.mockImplementation((handler) => {
      messageHandler = handler;
    });

    onConnectHandler(mockPort);

    // Call a tool
    const resultPromise = lifecycleManager.callTool(123, 'test-tool', { input: 'test' });

    // Find the tools/call message (first message is tools/list request)
    const toolCallMsg = mockPort.postMessage.mock.calls.find(
      (call) => call[0]?.payload?.method === 'tools/call'
    );
    expect(toolCallMsg).toBeDefined();
    expect(toolCallMsg![0]).toMatchObject({
      type: 'webmcp',
      payload: expect.objectContaining({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'test-tool',
          arguments: { input: 'test' },
        },
      }),
    });

    // Simulate response using the correct request ID from tools/call
    const requestId = toolCallMsg![0].payload.id;

    if (messageHandler) {
      (messageHandler as Function)({
        type: 'webmcp',
        payload: {
          jsonrpc: '2.0',
          id: requestId,
          result: { output: 'success' },
        },
      });
    }

    // Verify promise resolves
    const result = await resultPromise;
    expect(result).toEqual({ output: 'success' });
  });
});
