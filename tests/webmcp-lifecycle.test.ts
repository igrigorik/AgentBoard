/**
 * Tests for WebMCP TabManager
 * Tests script injection timing, navigation handling, and port management
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TabManager } from '../src/lib/webmcp/lifecycle';

// Mock ConfigStorage before importing lifecycle
vi.mock('../src/lib/storage/config', () => ({
  ConfigStorage: {
    getInstance: vi.fn(() => ({
      get: vi.fn().mockResolvedValue({ builtinScripts: [] }),
      getBuiltinScripts: vi.fn().mockResolvedValue([]),
      isBuiltinToolEnabled: vi.fn().mockResolvedValue(true), // All built-ins enabled by default
      getUserScripts: vi.fn().mockResolvedValue([]),
    })),
  },
}));

// Mock Chrome APIs
const mockChrome = {
  runtime: {
    onConnect: {
      addListener: vi.fn(),
    },
    sendMessage: vi.fn().mockImplementation(() => Promise.resolve()),
    lastError: null,
  },
  webNavigation: {
    onBeforeNavigate: {
      addListener: vi.fn(),
    },
    onDOMContentLoaded: {
      addListener: vi.fn(),
    },
  },
  tabs: {
    onRemoved: {
      addListener: vi.fn(),
    },
    get: vi.fn(),
  },
  scripting: {
    executeScript: vi.fn(),
  },
};

(global as any).chrome = mockChrome;
// Use globalThis which is more flexible than global
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      randomUUID: () => `test-uuid-${Math.random()}`,
    },
    writable: true,
    configurable: true,
  });
} else {
  // If crypto exists, just mock randomUUID
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => `test-uuid-${Math.random()}` as `${string}-${string}-${string}-${string}-${string}`
  );
}
// We'll use vi.useFakeTimers() in tests that need timer control
// For now, just spy on the functions without breaking them
vi.spyOn(global, 'setTimeout');
vi.spyOn(global, 'clearTimeout');

describe('TabManager', () => {
  let lifecycle: TabManager;
  let portHandlers: any = {};
  let navHandlers: any = {};
  let tabHandlers: any = {};

  beforeEach(() => {
    vi.clearAllMocks();

    // Capture event handlers
    mockChrome.runtime.onConnect.addListener = vi.fn((handler) => {
      portHandlers.onConnect = handler;
    });

    mockChrome.webNavigation.onBeforeNavigate.addListener = vi.fn((handler) => {
      navHandlers.onBeforeNavigate = handler;
    });

    mockChrome.webNavigation.onDOMContentLoaded.addListener = vi.fn((handler) => {
      navHandlers.onDOMContentLoaded = handler;
    });

    mockChrome.tabs.onRemoved.addListener = vi.fn((handler) => {
      tabHandlers.onRemoved = handler;
    });

    lifecycle = new TabManager();
  });

  afterEach(() => {
    portHandlers = {};
    navHandlers = {};
    tabHandlers = {};
  });

  describe('Port Connection Handling', () => {
    it('should handle content script port connections', () => {
      const mockPort = {
        name: 'webmcp-content-script',
        sender: {
          tab: { id: 123 },
        },
        onMessage: {
          addListener: vi.fn(),
        },
        onDisconnect: {
          addListener: vi.fn(),
        },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      portHandlers.onConnect(mockPort);

      // Verify port is stored
      expect(mockPort.onMessage.addListener).toHaveBeenCalled();
      expect(mockPort.onDisconnect.addListener).toHaveBeenCalled();
    });

    it('should ignore non-WebMCP port connections', () => {
      const mockPort = {
        name: 'other-port',
        sender: {
          tab: { id: 123 },
        },
        onMessage: {
          addListener: vi.fn(),
        },
        onDisconnect: {
          addListener: vi.fn(),
        },
      };

      portHandlers.onConnect(mockPort);

      expect(mockPort.onMessage.addListener).not.toHaveBeenCalled();
    });

    it('should reject ports without tab ID', () => {
      const mockPort = {
        name: 'webmcp-content-script',
        sender: {},
        onMessage: {
          addListener: vi.fn(),
        },
        onDisconnect: {
          addListener: vi.fn(),
        },
      };

      portHandlers.onConnect(mockPort);

      // Verify port was rejected (no listeners attached)
      expect(mockPort.onMessage.addListener).not.toHaveBeenCalled();
    });

    it('should flush pending messages when port connects', () => {
      const mockPort = {
        name: 'webmcp-content-script',
        sender: {
          tab: { id: 123 },
        },
        onMessage: {
          addListener: vi.fn(),
        },
        onDisconnect: {
          addListener: vi.fn(),
        },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      // Queue some messages before connection
      lifecycle.sendToTab(123, { type: 'test1' });
      lifecycle.sendToTab(123, { type: 'test2' });

      // Connect port
      portHandlers.onConnect(mockPort);

      // Messages should be flushed
      expect(mockPort.postMessage).toHaveBeenCalledTimes(2);
      expect(mockPort.postMessage).toHaveBeenNthCalledWith(1, { type: 'test1' });
      expect(mockPort.postMessage).toHaveBeenNthCalledWith(2, { type: 'test2' });
    });
  });

  describe('Navigation Monitoring', () => {
    it('should track navigation start and cancel pending calls', async () => {
      // First connect a port so tool call can be sent
      const mockPort = {
        name: 'webmcp-content-script',
        sender: {
          tab: { id: 123 },
        },
        onMessage: {
          addListener: vi.fn(),
        },
        onDisconnect: {
          addListener: vi.fn(),
        },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      portHandlers.onConnect(mockPort);

      // Start a tool call (it will be queued)
      const promise = lifecycle.callTool(123, 'test-tool', {});

      // Small delay to ensure promise is set up
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Trigger navigation which should cancel pending calls
      navHandlers.onBeforeNavigate({
        tabId: 123,
        frameId: 0,
      });

      // Promise should reject
      await expect(promise).rejects.toThrow('Tool call cancelled');
    });

    it('should inject scripts on DOM ready after navigation', async () => {
      mockChrome.tabs.get.mockResolvedValue({
        id: 123,
        url: 'https://example.com',
      });

      // Mock executeScript to succeed
      mockChrome.scripting.executeScript.mockResolvedValue(undefined);

      // Mark for injection
      navHandlers.onBeforeNavigate({
        tabId: 123,
        frameId: 0,
      });

      // DOM ready
      navHandlers.onDOMContentLoaded({
        tabId: 123,
        frameId: 0,
      });

      // Wait for async injection
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should inject: relay + polyfill + 4 compiled tools + bridge = 7 scripts
      expect(mockChrome.scripting.executeScript).toHaveBeenCalledTimes(7);

      // Check relay injection (FIRST - critical for race condition fix!)
      expect(mockChrome.scripting.executeScript).toHaveBeenCalledWith({
        target: { tabId: 123, frameIds: [0] },
        world: 'ISOLATED',
        injectImmediately: true,
        files: ['content-scripts/relay.js'],
      });

      // Check polyfill injection (SECOND)
      expect(mockChrome.scripting.executeScript).toHaveBeenCalledWith({
        target: { tabId: 123, frameIds: [0] },
        world: 'MAIN',
        injectImmediately: true,
        files: ['content-scripts/webmcp-polyfill.js'],
      });

      // Check bridge injection
      expect(mockChrome.scripting.executeScript).toHaveBeenCalledWith({
        target: { tabId: 123, frameIds: [0] },
        world: 'MAIN',
        injectImmediately: false,
        files: ['content-scripts/page-bridge.js'],
      });
    });

    it('should ignore non-main frame navigation', () => {
      navHandlers.onBeforeNavigate({
        tabId: 123,
        frameId: 1, // Not main frame
      });

      navHandlers.onDOMContentLoaded({
        tabId: 123,
        frameId: 1,
      });

      expect(mockChrome.scripting.executeScript).not.toHaveBeenCalled();
    });

    it('should skip injection for restricted URLs', async () => {
      mockChrome.tabs.get.mockResolvedValue({
        id: 123,
        url: 'chrome://extensions',
      });

      await lifecycle.injectScripts(123);

      expect(mockChrome.scripting.executeScript).not.toHaveBeenCalled();

      // Test other restricted URLs
      mockChrome.tabs.get.mockResolvedValue({
        id: 123,
        url: 'chrome-extension://abc123',
      });

      await lifecycle.injectScripts(123);
      expect(mockChrome.scripting.executeScript).not.toHaveBeenCalled();
    });
  });

  describe('Tool Registry Management', () => {
    it('should update tool registry when receiving tools/listChanged', () => {
      const mockPort = {
        name: 'webmcp-content-script',
        sender: {
          tab: { id: 123 },
        },
        onMessage: {
          addListener: vi.fn(),
        },
        onDisconnect: {
          addListener: vi.fn(),
        },
        postMessage: vi.fn(),
      };

      let messageHandler: Function | null = null;
      mockPort.onMessage.addListener = vi.fn((handler) => {
        messageHandler = handler;
      });

      portHandlers.onConnect(mockPort);

      // Send tools/listChanged notification
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
              timestamp: Date.now(),
            },
          },
        });
      }

      const registry = lifecycle.getToolRegistry(123);
      expect(registry).toBeDefined();
      expect(registry?.tools).toHaveLength(2);
      expect(registry?.origin).toBe('https://example.com');
    });
  });

  describe('Tool Call Execution', () => {
    it('should send tool call request and resolve with result', async () => {
      const mockPort = {
        name: 'webmcp-content-script',
        sender: {
          tab: { id: 123 },
        },
        onMessage: {
          addListener: vi.fn(),
        },
        onDisconnect: {
          addListener: vi.fn(),
        },
        postMessage: vi.fn(),
      };

      let messageHandler: Function | null = null;
      mockPort.onMessage.addListener = vi.fn((handler) => {
        messageHandler = handler;
      });

      portHandlers.onConnect(mockPort);

      // Start tool call
      const promise = lifecycle.callTool(123, 'test-tool', { param: 'value' });

      // Verify request sent
      expect(mockPort.postMessage).toHaveBeenCalledWith({
        type: 'webmcp',
        payload: {
          jsonrpc: '2.0',
          id: expect.stringContaining('test-uuid'),
          method: 'tools/call',
          params: {
            name: 'test-tool',
            arguments: { param: 'value' },
          },
        },
      });

      // Get the request ID
      const call = mockPort.postMessage.mock.calls[0][0];
      const requestId = call.payload.id;

      // Send response
      if (messageHandler) {
        (messageHandler as Function)({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            result: { success: true },
          },
        });
      }

      const result = await promise;
      expect(result).toEqual({ success: true });
    });

    it('should reject tool call on error response', async () => {
      const mockPort = {
        name: 'webmcp-content-script',
        sender: {
          tab: { id: 123 },
        },
        onMessage: {
          addListener: vi.fn(),
        },
        onDisconnect: {
          addListener: vi.fn(),
        },
        postMessage: vi.fn(),
      };

      let messageHandler: Function | null = null;
      mockPort.onMessage.addListener = vi.fn((handler) => {
        messageHandler = handler;
      });

      portHandlers.onConnect(mockPort);

      const promise = lifecycle.callTool(123, 'failing-tool', {});

      const call = mockPort.postMessage.mock.calls[0][0];
      const requestId = call.payload.id;

      // Send error response
      if (messageHandler) {
        (messageHandler as Function)({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            error: {
              code: -32000,
              message: 'Tool execution failed',
            },
          },
        });
      }

      await expect(promise).rejects.toThrow('Tool execution failed');
    });

    it('should timeout tool calls after 10 seconds', async () => {
      vi.useFakeTimers();

      const promise = lifecycle.callTool(123, 'slow-tool', {});

      // Advance time past timeout
      vi.advanceTimersByTime(10001);

      await expect(promise).rejects.toThrow('No connection to tab 123');

      vi.useRealTimers();
    });
  });

  describe('Tab Cleanup', () => {
    it('should clean up resources when tab is removed', () => {
      // Setup some state for tab
      const mockPort = {
        name: 'webmcp-content-script',
        sender: {
          tab: { id: 123 },
        },
        onMessage: {
          addListener: vi.fn(),
        },
        onDisconnect: {
          addListener: vi.fn(),
        },
        postMessage: vi.fn(),
      };

      portHandlers.onConnect(mockPort);

      // Add some tool registry
      if (mockPort.onMessage.addListener.mock.calls[0]) {
        const handler = mockPort.onMessage.addListener.mock.calls[0][0];
        handler({
          type: 'webmcp',
          payload: {
            method: 'tools/listChanged',
            params: {
              tools: [{ name: 'test-tool', description: 'Test' }],
              origin: 'https://example.com',
            },
          },
        });
      }

      // Verify state exists
      expect(lifecycle.getToolRegistry(123)).toBeDefined();

      // Remove tab
      tabHandlers.onRemoved(123);

      // Verify cleanup
      expect(lifecycle.getToolRegistry(123)).toBeUndefined();
    });

    it('should cancel pending tool calls when tab is removed', async () => {
      // Connect a port first
      const mockPort = {
        name: 'webmcp-content-script',
        sender: {
          tab: { id: 123 },
        },
        onMessage: {
          addListener: vi.fn(),
        },
        onDisconnect: {
          addListener: vi.fn(),
        },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      portHandlers.onConnect(mockPort);

      // Start the tool call - this creates a pending promise
      const promise = lifecycle.callTool(123, 'test-tool', {});

      // Small delay to ensure promise is set up and message is sent
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Remove tab while the call is pending - this should cancel it
      tabHandlers.onRemoved(123);

      // The promise should be rejected with cancellation
      await expect(promise).rejects.toThrow('Tool call cancelled');
    });
  });

  describe('Script Injection', () => {
    it('should inject scripts in correct order and timing', async () => {
      mockChrome.tabs.get.mockResolvedValue({
        id: 123,
        url: 'https://example.com',
      });

      await lifecycle.injectScripts(123);

      const calls = mockChrome.scripting.executeScript.mock.calls;

      // Verify NEW order and timing (changed to fix race condition on strict CSP sites)
      // 1. Relay FIRST (must be listening when bridge sends initial snapshot)
      expect(calls[0][0]).toEqual({
        target: { tabId: 123, frameIds: [0] },
        world: 'ISOLATED',
        injectImmediately: true,
        files: ['content-scripts/relay.js'],
      });

      // 2. Polyfill SECOND
      expect(calls[1][0]).toEqual({
        target: { tabId: 123, frameIds: [0] },
        world: 'MAIN',
        injectImmediately: true,
        files: ['content-scripts/webmcp-polyfill.js'],
      });

      // 3-6. Four compiled tools (in MAIN world, after polyfill)
      // (We won't check each one individually, just verify they're injected)

      // 7. Bridge LAST (after relay is ready and tools are registered)
      expect(calls[6][0]).toEqual({
        target: { tabId: 123, frameIds: [0] },
        world: 'MAIN',
        injectImmediately: false,
        files: ['content-scripts/page-bridge.js'],
      });
    });

    it('should handle injection errors gracefully', async () => {
      // Spy on log.error instead of console.error
      const { default: log } = await import('../src/lib/logger');
      const logSpy = vi.spyOn(log, 'error').mockImplementation(() => {});

      mockChrome.tabs.get.mockResolvedValue({
        id: 123,
        url: 'https://example.com',
      });

      mockChrome.scripting.executeScript.mockRejectedValue(new Error('Cannot access tab'));

      await lifecycle.injectScripts(123);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to inject scripts'),
        expect.any(Error)
      );

      logSpy.mockRestore();
    });
  });
});
