/**
 * Integration tests for WebMCP navigation handling and script re-injection
 * Tests navigation flows, port lifecycle, and script persistence
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TabManager } from '../../src/lib/webmcp/lifecycle';

describe('WebMCP Navigation Integration', () => {
  let mockChrome: any;
  let lifecycleManager: TabManager;
  let navigationHandlers: {
    onBeforeNavigate?: Function;
    onDOMContentLoaded?: Function;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    navigationHandlers = {};

    // Setup comprehensive Chrome mock
    mockChrome = {
      runtime: {
        onMessage: {
          addListener: vi.fn(),
        },
        onConnect: {
          addListener: vi.fn(),
        },
        sendMessage: vi.fn().mockResolvedValue(undefined),
        getURL: vi.fn((path: string) => `chrome-extension://ext-id/${path}`),
        lastError: null,
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
        session: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
      tabs: {
        get: vi.fn((tabId: number) =>
          Promise.resolve({ id: tabId, url: `https://example.com?tab=${tabId}` })
        ),
        onRemoved: {
          addListener: vi.fn(),
        },
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue(undefined),
      },
      webNavigation: {
        onBeforeNavigate: {
          addListener: vi.fn((handler: Function) => {
            navigationHandlers.onBeforeNavigate = handler;
          }),
        },
        onDOMContentLoaded: {
          addListener: vi.fn((handler: Function) => {
            navigationHandlers.onDOMContentLoaded = handler;
          }),
        },
      },
    };

    (global as any).chrome = mockChrome;

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

    // Initialize the lifecycle manager
    lifecycleManager = new TabManager();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.clearAllMocks();
  });

  describe('Navigation Lifecycle', () => {
    it('should cancel pending tool calls on navigation start', async () => {
      // Setup connection
      const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];
      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };
      onConnectHandler(mockPort);

      // Start a tool call
      const toolCallPromise = lifecycleManager.callTool(123, 'test-tool', { input: 'test' });

      // Trigger navigation (should cancel the tool call)
      if (navigationHandlers.onBeforeNavigate) {
        navigationHandlers.onBeforeNavigate({
          tabId: 123,
          frameId: 0,
          url: 'https://example.com/new-page',
        });
      }

      // Verify the promise rejects
      await expect(toolCallPromise).rejects.toThrow('Tool call cancelled');
    });

    it('should reinject scripts after navigation completes', async () => {
      const tabId = 123;

      // Simulate navigation start
      if (navigationHandlers.onBeforeNavigate) {
        navigationHandlers.onBeforeNavigate({
          tabId,
          frameId: 0,
          url: 'https://example.com/page1',
        });
      }

      // Verify no injection yet
      expect(mockChrome.scripting.executeScript).not.toHaveBeenCalled();

      // Simulate DOM ready
      if (navigationHandlers.onDOMContentLoaded) {
        await navigationHandlers.onDOMContentLoaded({
          tabId,
          frameId: 0,
          url: 'https://example.com/page1',
        });
      }

      // Verify scripts were injected: relay + polyfill + 3 matching tools + bridge = 6
      // (youtube_transcript only matches youtube.com, not example.com)
      const expectedScriptCount = 6; // 3 core scripts + 3 matching tools
      expect(mockChrome.scripting.executeScript).toHaveBeenCalledTimes(expectedScriptCount);

      // Check relay injection FIRST (critical for race condition fix)
      expect(mockChrome.scripting.executeScript).toHaveBeenNthCalledWith(1, {
        target: { tabId, frameIds: [0] },
        world: 'ISOLATED',
        injectImmediately: true,
        files: ['content-scripts/relay.js'],
      });

      // Check polyfill injection second
      expect(mockChrome.scripting.executeScript).toHaveBeenNthCalledWith(2, {
        target: { tabId, frameIds: [0] },
        injectImmediately: true,
        world: 'MAIN',
        files: ['content-scripts/webmcp-polyfill.js'],
      });

      // Check bridge injection LAST (call #6 - after 3 matching tools)
      expect(mockChrome.scripting.executeScript).toHaveBeenNthCalledWith(6, {
        target: { tabId, frameIds: [0] },
        world: 'MAIN',
        injectImmediately: false,
        files: ['content-scripts/page-bridge.js'],
      });
    });

    it('should handle multiple rapid navigations without double injection', async () => {
      const tabId = 456;

      // First navigation
      if (navigationHandlers.onBeforeNavigate) {
        navigationHandlers.onBeforeNavigate({
          tabId,
          frameId: 0,
          url: 'https://example.com/page1',
        });
      }

      // Second navigation before first completes
      if (navigationHandlers.onBeforeNavigate) {
        navigationHandlers.onBeforeNavigate({
          tabId,
          frameId: 0,
          url: 'https://example.com/page2',
        });
      }

      // Only second navigation's DOM ready should trigger injection
      if (navigationHandlers.onDOMContentLoaded) {
        await navigationHandlers.onDOMContentLoaded({
          tabId,
          frameId: 0,
          url: 'https://example.com/page2',
        });
      }

      // Should inject only once: relay + polyfill + 3 matching tools + bridge = 6
      const expectedScriptCount = 6; // 3 core scripts + 3 matching tools
      expect(mockChrome.scripting.executeScript).toHaveBeenCalledTimes(expectedScriptCount);
    });

    it('should ignore subframe navigations', async () => {
      const tabId = 789;

      // Subframe navigation (frameId !== 0)
      if (navigationHandlers.onBeforeNavigate) {
        navigationHandlers.onBeforeNavigate({
          tabId,
          frameId: 1, // subframe
          url: 'https://example.com/iframe',
        });
      }

      if (navigationHandlers.onDOMContentLoaded) {
        await navigationHandlers.onDOMContentLoaded({
          tabId,
          frameId: 1, // subframe
          url: 'https://example.com/iframe',
        });
      }

      // Should not inject scripts for subframes
      expect(mockChrome.scripting.executeScript).not.toHaveBeenCalled();
    });
  });

  describe('Port Reconnection and Recovery', () => {
    it('should handle port disconnection and reconnection', async () => {
      const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];

      // First connection
      const mockPort1 = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      let disconnectHandler1: (() => void) | null = null;
      mockPort1.onDisconnect.addListener = vi.fn((handler) => {
        disconnectHandler1 = handler;
      });

      onConnectHandler(mockPort1);

      // Simulate port disconnect
      if (disconnectHandler1) {
        (disconnectHandler1 as () => void)();
      }

      // Second connection (reconnect)
      const mockPort2 = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      onConnectHandler(mockPort2);

      // Tool call should use new port
      const callPromise = lifecycleManager.callTool(123, 'test-tool', { input: 'test' });

      // Port2 should receive tools/list request + tool call
      expect(mockPort2.postMessage).toHaveBeenCalled();
      // Port1 might have received tools/list on first connection, but not the new tool call
      const port1ToolCalls = mockPort1.postMessage.mock.calls.filter(
        (call) => call[0]?.payload?.method === 'tools/call'
      );
      expect(port1ToolCalls).toHaveLength(0);

      // Simulate response to prevent timeout
      // Find the tools/call request (not tools/list)
      const toolCallRequest = mockPort2.postMessage.mock.calls.find(
        (call) => call[0]?.payload?.method === 'tools/call'
      );
      expect(toolCallRequest).toBeDefined();

      const messageHandler = mockPort2.onMessage.addListener.mock.calls[0]?.[0];
      if (messageHandler) {
        messageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: toolCallRequest![0].payload.id,
            result: { success: true },
          },
        });
      }

      await expect(callPromise).resolves.toEqual({ success: true });
    });

    it('should fail immediately when port is disconnected', async () => {
      const tabId = 234;

      // No connection yet - calls should fail immediately
      const promise1 = lifecycleManager.callTool(tabId, 'tool1', { arg: 'value1' });
      const promise2 = lifecycleManager.callTool(tabId, 'tool2', { arg: 'value2' });

      // Both promises should reject immediately
      await expect(promise1).rejects.toThrow('No connection to tab 234');
      await expect(promise2).rejects.toThrow('No connection to tab 234');
    });

    it('should clean up old port on new connection from same tab', () => {
      const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];

      // First connection
      const mockPort1 = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 456 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      onConnectHandler(mockPort1);

      // Second connection from same tab
      const mockPort2 = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 456 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      onConnectHandler(mockPort2);

      // Old port should be disconnected
      expect(mockPort1.disconnect).toHaveBeenCalled();
    });
  });

  describe('Tab Cleanup', () => {
    it('should clean up resources when tab is removed', async () => {
      const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];
      const onTabRemovedHandler = mockChrome.tabs.onRemoved.addListener.mock.calls[0]?.[0];

      // Setup connection
      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 999 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      onConnectHandler(mockPort);

      // Start a tool call
      const toolCallPromise = lifecycleManager.callTool(999, 'test-tool', {});

      // Remove tab
      if (onTabRemovedHandler) {
        onTabRemovedHandler(999);
      }

      // Promise should reject
      await expect(toolCallPromise).rejects.toThrow('Tool call cancelled');
    });

    it('should handle multiple tabs independently', async () => {
      const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];

      // Connect tab 1
      const mockPort1 = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 111 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      onConnectHandler(mockPort1);

      // Connect tab 2
      const mockPort2 = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 222 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      onConnectHandler(mockPort2);

      // Call tools on both tabs
      void lifecycleManager.callTool(111, 'tool1', {});
      void lifecycleManager.callTool(222, 'tool2', {});

      // Each port should get its own message
      expect(mockPort1.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'webmcp',
          payload: expect.objectContaining({
            params: { name: 'tool1', arguments: {} },
          }),
        })
      );

      expect(mockPort2.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'webmcp',
          payload: expect.objectContaining({
            params: { name: 'tool2', arguments: {} },
          }),
        })
      );
    });
  });

  describe('Message Ordering', () => {
    it('should maintain message order during port transitions', async () => {
      const tabId = 567;
      const messages: string[] = [];

      // Mock port that logs messages (filter out tools/list requests)
      const createMockPort = (id: string) => ({
        name: 'webmcp-content-script',
        sender: { tab: { id: tabId } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn((msg) => {
          // Only log tool calls, not tools/list requests
          if (msg.payload.method === 'tools/call') {
            messages.push(`${id}:${msg.payload.params.name}`);
          }
        }),
        disconnect: vi.fn(),
      });

      const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];

      // Connect first
      const port1 = createMockPort('p1');
      onConnectHandler(port1);

      // Now send messages
      lifecycleManager.callTool(tabId, 'tool1', {});
      lifecycleManager.callTool(tabId, 'tool2', {});

      // Messages should be sent in order
      expect(messages).toEqual(['p1:tool1', 'p1:tool2']);

      // Send more messages
      messages.length = 0;
      lifecycleManager.callTool(tabId, 'tool3', {});
      lifecycleManager.callTool(tabId, 'tool4', {});

      expect(messages).toEqual(['p1:tool3', 'p1:tool4']);
    });
  });
});
