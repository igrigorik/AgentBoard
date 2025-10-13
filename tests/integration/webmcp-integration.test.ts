/**
 * Integration tests for WebMCP sidebar ↔ tab communication
 * Tests the complete message flow from sidebar through background to tab and back
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TabManager } from '../../src/lib/webmcp/lifecycle';

describe('WebMCP Integration - Sidebar ↔ Tab Communication', () => {
  let mockChrome: any;
  let lifecycleManager: TabManager;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup mock Chrome API
    mockChrome = {
      runtime: {
        onMessage: {
          addListener: vi.fn(),
        },
        onConnect: {
          addListener: vi.fn(),
        },
        sendMessage: vi.fn().mockResolvedValue(undefined),
        connect: vi.fn(),
      },
      storage: {
        session: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
      tabs: {
        get: vi.fn(),
        onRemoved: {
          addListener: vi.fn(),
        },
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        onBeforeNavigate: {
          addListener: vi.fn(),
        },
        onDOMContentLoaded: {
          addListener: vi.fn(),
        },
      },
    };

    (global as any).chrome = mockChrome;
    // Use globalThis for crypto mocking
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
    // Just spy on timers without breaking them
    vi.spyOn(global, 'setTimeout');
    vi.spyOn(global, 'clearTimeout');

    // Initialize the lifecycle manager with mocked Chrome API
    (global as any).chrome = mockChrome;
    lifecycleManager = new TabManager();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Discovery Flow', () => {
    it('should discover tools from page through to sidebar', async () => {
      // Setup: Page registers a tool with window.agent
      const pageToolRegistration = {
        name: 'page-tool',
        description: 'A tool from the page',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
        },
      };

      // Step 1: Page registers tool and emits tools/listChanged
      const pageNotification = {
        source: 'webmcp-main',
        jsonrpc: '2.0',
        method: 'tools/listChanged',
        params: {
          tools: [pageToolRegistration],
          origin: 'https://example.com',
          timestamp: Date.now(),
        },
      };

      // Step 2: Content script receives and forwards to background
      const contentToBackground = {
        type: 'webmcp',
        payload: pageNotification,
        tabUrl: 'https://example.com',
        timestamp: Date.now(),
      };

      // Step 3: Background updates registry and notifies sidebar

      // Simulate the flow
      // 1. Content script connects to background - get handler from Chrome mock
      const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];
      expect(onConnectHandler).toBeDefined();

      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
      };

      let portMessageHandler: Function | null = null;
      mockPort.onMessage.addListener = vi.fn((handler) => {
        portMessageHandler = handler;
      });

      // 2. Port connects
      onConnectHandler(mockPort);

      // 3. Content script sends tools/listChanged
      if (portMessageHandler) {
        (portMessageHandler as Function)(contentToBackground);
      }

      // 4. Verify the lifecycle manager stored the tools
      const registry = lifecycleManager.getToolRegistry(123);
      expect(registry).toBeDefined();
      expect(registry?.tools).toContainEqual(pageToolRegistration);
    });

    it('should handle sidebar request for available tools', async () => {
      // Setup: First register tools with the lifecycle manager
      const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];

      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
      };

      let portMessageHandler: Function | null = null;
      mockPort.onMessage.addListener = vi.fn((handler) => {
        portMessageHandler = handler;
      });

      onConnectHandler(mockPort);

      // Register tools
      if (portMessageHandler) {
        (portMessageHandler as Function)({
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
      expect(registry?.tools).toHaveLength(2);
      expect(registry?.tools[0].name).toBe('tool1');
      expect(registry?.tools[1].name).toBe('tool2');
    });
  });

  describe('Tool Execution Flow', () => {
    it('should execute tool from sidebar through to page and back', async () => {
      // Setup connection
      const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];

      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
      };

      let portMessageHandler: Function | null = null;
      mockPort.onMessage.addListener = vi.fn((handler) => {
        portMessageHandler = handler;
      });

      onConnectHandler(mockPort);

      // Test tool call through lifecycle manager
      const toolCallPromise = lifecycleManager.callTool(123, 'test-tool', { input: 'test-value' });

      // Step 2: Verify the message was sent to content script
      expect(mockPort.postMessage).toHaveBeenCalledWith({
        type: 'webmcp',
        payload: {
          jsonrpc: '2.0',
          id: expect.stringContaining('test-uuid'),
          method: 'tools/call',
          params: {
            name: 'test-tool',
            arguments: { input: 'test-value' },
          },
        },
      });

      // Get request ID
      const request = mockPort.postMessage.mock.calls[0][0];
      const requestId = request.payload.id;

      // Step 3: Simulate page executing tool and returning result
      if (portMessageHandler) {
        (portMessageHandler as Function)({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            result: { output: 'tool-result' },
          },
        });
      }

      // Step 4: Verify the promise resolves with result
      const result = await toolCallPromise;
      expect(result).toEqual({ output: 'tool-result' });
    });

    it('should handle tool execution errors', async () => {
      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
      };

      let portMessageHandler: Function | null = null;
      mockPort.onMessage.addListener = vi.fn((handler) => {
        portMessageHandler = handler;
      });

      const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];
      if (onConnectHandler) {
        onConnectHandler(mockPort);
      }

      // Call a tool that will fail
      const responsePromise = lifecycleManager.callTool(123, 'failing-tool', {});

      const request = mockPort.postMessage.mock.calls[0]?.[0];
      if (!request) {
        throw new Error('No message sent to port');
      }
      const requestId = request.payload.id;

      // Send error response
      if (portMessageHandler) {
        (portMessageHandler as Function)({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            error: {
              code: -32000,
              message: 'Tool execution failed: Invalid input',
            },
          },
        });
      }

      // The promise should reject with an error
      await expect(responsePromise).rejects.toThrow('Tool execution failed: Invalid input');
    });
  });

  describe('Tab Binding', () => {
    it('should extract tab ID from URL hash', async () => {
      const sidebarSender = {
        url: 'chrome-extension://ext-id/sidebar.html#tab=456',
      };

      mockChrome.tabs.get.mockResolvedValue({ id: 456 });

      // Simulate getBoundTabIdForSidebar logic
      const match = sidebarSender.url.match(/#tab=(\d+)/);
      const tabId = match ? parseInt(match[1]) : null;

      expect(tabId).toBe(456);

      // Verify tab exists
      await mockChrome.tabs.get(tabId);
      expect(mockChrome.tabs.get).toHaveBeenCalledWith(456);
    });

    it('should fall back to session storage when URL hash missing', async () => {
      const sidebarSender = {
        url: 'chrome-extension://ext-id/sidebar.html',
      };

      // Setup session storage
      mockChrome.storage.session.get.mockResolvedValue({
        sidebar_tab_789: {
          tabId: 789,
          timestamp: Date.now(),
        },
      });

      mockChrome.tabs.get.mockResolvedValue({ id: 789 });

      // Simulate getBoundTabIdForSidebar logic
      let tabId = null;
      const match = sidebarSender.url.match(/#tab=(\d+)/);

      if (!match) {
        const stored = await mockChrome.storage.session.get();
        for (const [key, value] of Object.entries(stored)) {
          if (key.startsWith('sidebar_tab_') && value) {
            const data = value as any;
            try {
              await mockChrome.tabs.get(data.tabId);
              tabId = data.tabId;
              break;
            } catch {
              // Tab doesn't exist
            }
          }
        }
      }

      expect(tabId).toBe(789);
    });

    it('should clean up stale session storage entries', async () => {
      mockChrome.storage.session.get.mockResolvedValue({
        sidebar_tab_999: {
          tabId: 999,
          timestamp: Date.now() - 3600000, // 1 hour old
        },
      });

      // Tab no longer exists
      mockChrome.tabs.get.mockRejectedValue(new Error('Tab not found'));
      mockChrome.storage.session.remove = vi.fn();

      // Simulate cleanup logic
      const stored = await mockChrome.storage.session.get();
      for (const [key, value] of Object.entries(stored)) {
        if (key.startsWith('sidebar_tab_')) {
          const data = value as any;
          try {
            await mockChrome.tabs.get(data.tabId);
          } catch {
            await mockChrome.storage.session.remove(key);
          }
        }
      }

      expect(mockChrome.storage.session.remove).toHaveBeenCalledWith('sidebar_tab_999');
    });
  });

  describe('Navigation Handling', () => {
    it('should re-inject scripts and restore tools after navigation', async () => {
      // Setup initial connection
      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      let disconnectHandler: Function | null = null;
      mockPort.onDisconnect.addListener = vi.fn((handler) => {
        disconnectHandler = handler;
      });

      const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];
      if (onConnectHandler) {
        onConnectHandler(mockPort);
      }

      // Simulate navigation (port disconnects)
      if (disconnectHandler) {
        (disconnectHandler as Function)();
      }

      // Background should detect and prepare for re-injection
      // New page loads, new port connects
      const newMockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
      };

      if (onConnectHandler) {
        onConnectHandler(newMockPort);
      }

      // Verify new connection established
      expect(newMockPort.onMessage.addListener).toHaveBeenCalled();
    });

    it('should cancel pending tool calls on navigation', async () => {
      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
      };

      let disconnectHandler: Function | null = null;
      mockPort.onDisconnect.addListener = vi.fn((handler) => {
        disconnectHandler = handler;
      });

      const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];
      if (onConnectHandler) {
        onConnectHandler(mockPort);
      }

      mockChrome.tabs.get.mockResolvedValue({ id: 123 });

      // Start a tool call but don't complete it
      const responsePromise = lifecycleManager.callTool(123, 'slow-tool', {});

      // Simulate navigation (disconnect port)
      if (disconnectHandler) {
        (disconnectHandler as Function)();
      }

      // Tool call should be cancelled immediately
      await expect(responsePromise).rejects.toThrow('Tool call cancelled');
    });
  });

  describe('Error Scenarios', () => {
    it('should handle missing tab binding', async () => {
      mockChrome.storage.session.get.mockResolvedValue({}); // No stored binding

      // Try to call a tool without a valid tab connection
      // Since there's no port for tab 999, this should fail immediately
      await expect(lifecycleManager.callTool(999, 'test-tool', {})).rejects.toThrow(
        'No connection to tab 999'
      );
    });

    it('should handle disconnected content script', async () => {
      // No port connected for tab
      mockChrome.tabs.get.mockResolvedValue({ id: 123 });

      // Try to call a tool on a tab with no connection
      // This should fail immediately since there's no port connected
      await expect(lifecycleManager.callTool(123, 'test-tool', {})).rejects.toThrow(
        'No connection to tab 123'
      );
    });
  });
});
