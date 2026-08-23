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
    onHistoryStateUpdated: {
      addListener: vi.fn(),
    },
    onErrorOccurred: {
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

    mockChrome.webNavigation.onHistoryStateUpdated.addListener = vi.fn((handler) => {
      navHandlers.onHistoryStateUpdated = handler;
    });

    mockChrome.webNavigation.onErrorOccurred.addListener = vi.fn((handler) => {
      navHandlers.onErrorOccurred = handler;
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

    it('pushes only the validated log level to connected relays', () => {
      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };
      portHandlers.onConnect(mockPort);
      mockPort.postMessage.mockClear();

      lifecycle.setRelayLogLevel('debug');

      expect(mockPort.postMessage).toHaveBeenCalledWith({
        type: 'RELAY_LOG_LEVEL',
        logLevel: 'debug',
      });
      expect(JSON.stringify(mockPort.postMessage.mock.calls)).not.toContain('agents');
      expect(JSON.stringify(mockPort.postMessage.mock.calls)).not.toContain('apiKey');
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

    it('should ignore queued messages from a replaced document port', () => {
      const makePort = () => ({
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      });
      const oldPort = makePort();
      const newPort = makePort();

      portHandlers.onConnect(oldPort);
      const oldHandler = oldPort.onMessage.addListener.mock.calls[0][0];
      portHandlers.onConnect(newPort);
      const newHandler = newPort.onMessage.addListener.mock.calls[0][0];
      const notification = (name: string) => ({
        type: 'webmcp',
        payload: {
          method: 'tools/listChanged',
          params: {
            tools: [{ name, description: name }],
            origin: 'https://example.com',
          },
        },
      });

      oldHandler(notification('stale_tool'));
      expect(lifecycle.getToolRegistry(123)).toBeUndefined();

      newHandler(notification('current_tool'));
      expect(lifecycle.getToolRegistry(123)?.tools.map(({ name }) => name)).toEqual([
        'current_tool',
      ]);
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

      // Messages should be flushed + tools/list request = 3 total
      expect(mockPort.postMessage).toHaveBeenCalledTimes(3);
      expect(mockPort.postMessage).toHaveBeenNthCalledWith(1, { type: 'test1' });
      expect(mockPort.postMessage).toHaveBeenNthCalledWith(2, { type: 'test2' });

      // Third call should be tools/list request
      const thirdCall = mockPort.postMessage.mock.calls[2][0];
      expect(thirdCall).toMatchObject({
        type: 'webmcp',
        payload: {
          method: 'tools/list',
        },
      });
    });
  });

  describe('Navigation Monitoring', () => {
    it('should revoke navigation-time capabilities while allowing an issued call to settle', async () => {
      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 }, documentId: 'retiring-document' },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };
      portHandlers.onConnect(mockPort);
      const messageHandler = mockPort.onMessage.addListener.mock.calls[0][0];
      const promise = lifecycle.callTool(123, 'navigation-tool', {});
      const requestId = mockPort.postMessage.mock.calls.find(
        (call) => call[0]?.payload?.method === 'tools/call'
      )![0].payload.id;

      navHandlers.onBeforeNavigate({ tabId: 123, frameId: 0 });

      await expect(lifecycle.callTool(123, 'stale-tool', {})).rejects.toThrow(
        'No connection to tab 123'
      );
      expect(
        mockPort.postMessage.mock.calls.some(
          (call) =>
            call[0]?.payload?.method === 'tools/cancel' &&
            call[0]?.payload?.params?.id === requestId
        )
      ).toBe(false);

      messageHandler({
        type: 'webmcp',
        payload: { jsonrpc: '2.0', id: requestId, result: 'navigation-started' },
      });
      await expect(promise).resolves.toBe('navigation-started');
    });

    it('should restore the surviving document when a provisional navigation fails', async () => {
      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 }, documentId: 'surviving-document' },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };
      portHandlers.onConnect(mockPort);
      const messageHandler = mockPort.onMessage.addListener.mock.calls[0][0];
      const promise = lifecycle.callTool(123, 'surviving_tool', {});
      const requestId = mockPort.postMessage.mock.calls.find(
        (call) => call[0]?.payload?.method === 'tools/call'
      )![0].payload.id;
      const catalog = {
        type: 'webmcp',
        payload: {
          method: 'tools/listChanged',
          params: {
            tools: [{ name: 'surviving_tool', description: 'Surviving tool' }],
            origin: 'https://example.com',
          },
        },
      };
      messageHandler(catalog);

      navHandlers.onBeforeNavigate({ tabId: 123, frameId: 0 });
      messageHandler(catalog);
      expect(lifecycle.getToolRegistry(123)).toBeUndefined();
      await expect(lifecycle.callTool(123, 'surviving_tool', {})).rejects.toThrow(
        'No connection to tab 123'
      );

      mockPort.postMessage.mockClear();
      navHandlers.onErrorOccurred({
        tabId: 123,
        frameId: 0,
        error: 'net::ERR_ABORTED',
      });
      expect(mockPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ method: 'tools/list' }),
        })
      );

      messageHandler(catalog);
      expect(lifecycle.getToolRegistry(123)?.tools.map(({ name }) => name)).toEqual([
        'surviving_tool',
      ]);
      messageHandler({
        type: 'webmcp',
        payload: { jsonrpc: '2.0', id: requestId, result: 'still-running' },
      });
      await expect(promise).resolves.toBe('still-running');
    });

    it('should reject relay reconnections from the retiring document', async () => {
      const makePort = (documentId: string) => ({
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 }, documentId },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      });
      const oldPort = makePort('old-document');
      portHandlers.onConnect(oldPort);

      navHandlers.onBeforeNavigate({ tabId: 123, frameId: 0 });

      const staleReconnect = makePort('old-document');
      portHandlers.onConnect(staleReconnect);
      expect(staleReconnect.disconnect).toHaveBeenCalledOnce();
      expect(staleReconnect.onMessage.addListener).not.toHaveBeenCalled();

      await navHandlers.onDOMContentLoaded({
        tabId: 123,
        frameId: 0,
        documentId: 'new-document',
      });
      await expect(lifecycle.callTool(123, 'stale_tool', {})).rejects.toThrow(
        'No connection to tab 123'
      );
      const delayedStaleReconnect = makePort('old-document');
      portHandlers.onConnect(delayedStaleReconnect);
      expect(delayedStaleReconnect.disconnect).toHaveBeenCalledOnce();
      expect(delayedStaleReconnect.onMessage.addListener).not.toHaveBeenCalled();

      const newPort = makePort('new-document');
      portHandlers.onConnect(newPort);
      expect(newPort.disconnect).not.toHaveBeenCalled();
      expect(newPort.onMessage.addListener).toHaveBeenCalledOnce();

      const unexpectedPort = makePort('unexpected-document');
      portHandlers.onConnect(unexpectedPort);
      expect(unexpectedPort.disconnect).toHaveBeenCalledOnce();
      expect(unexpectedPort.onMessage.addListener).not.toHaveBeenCalled();

      navHandlers.onBeforeNavigate({ tabId: 123, frameId: 0 });
      const restoredPort = makePort('old-document');
      portHandlers.onConnect(restoredPort);
      expect(restoredPort.disconnect).not.toHaveBeenCalled();
      expect(restoredPort.onMessage.addListener).toHaveBeenCalledOnce();
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

      // No page-owned tool matches example.com, so lifecycle injects only relay + bridge.
      // The manifest owns the polyfill; the system read_page host is injected only on demand.
      expect(mockChrome.scripting.executeScript).toHaveBeenCalledTimes(2);

      // Check relay injection (FIRST - critical for race condition fix!)
      expect(mockChrome.scripting.executeScript).toHaveBeenCalledWith({
        target: { tabId: 123, frameIds: [0] },
        world: 'ISOLATED',
        injectImmediately: true,
        files: ['content-scripts/relay.js'],
      });

      // Check bridge injection
      expect(mockChrome.scripting.executeScript).toHaveBeenCalledWith({
        target: { tabId: 123, frameIds: [0] },
        world: 'MAIN',
        injectImmediately: false,
        files: ['content-scripts/page-bridge.js'],
      });
    });

    it('should bind navigation injection to the DOM-ready document', async () => {
      mockChrome.scripting.executeScript.mockResolvedValueOnce([
        {
          documentId: 'document-new',
          frameId: 0,
          result: 'https://example.com/',
        },
      ]);
      mockChrome.scripting.executeScript.mockResolvedValue(undefined);

      navHandlers.onBeforeNavigate({ tabId: 123, frameId: 0 });
      navHandlers.onDOMContentLoaded({
        tabId: 123,
        frameId: 0,
        documentId: 'document-new',
      });
      await vi.waitFor(() => expect(mockChrome.scripting.executeScript).toHaveBeenCalledTimes(3));

      for (const [injection] of mockChrome.scripting.executeScript.mock.calls) {
        expect(injection.target).toEqual({ tabId: 123, documentIds: ['document-new'] });
      }
      expect(mockChrome.tabs.get).not.toHaveBeenCalled();
    });

    it('should await a fresh catalog after exact-document reinjection', async () => {
      const port = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 }, documentId: 'document-a', frameId: 0 },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };
      portHandlers.onConnect(port);
      mockChrome.scripting.executeScript.mockImplementation((injection) =>
        injection.world === 'ISOLATED' && injection.func
          ? Promise.resolve([
              {
                documentId: 'document-a',
                frameId: 0,
                result: 'https://example.com/',
              },
            ])
          : Promise.resolve(undefined)
      );
      const catalog = vi.spyOn(lifecycle, 'requestToolsAndWait').mockResolvedValue([]);

      await (lifecycle as any).reinjectDocumentScripts(123, 'document-a');

      expect(catalog).toHaveBeenCalledWith(123);
    });

    it('should reconcile same-document history updates against their exact document', async () => {
      const port = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 }, documentId: 'document-a', frameId: 0 },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };
      portHandlers.onConnect(port);
      const reinject = vi
        .spyOn(lifecycle as any, 'reinjectDocumentScripts')
        .mockResolvedValue(undefined);

      navHandlers.onHistoryStateUpdated({
        tabId: 123,
        frameId: 0,
        documentId: 'document-a',
      });

      await vi.waitFor(() => expect(reinject).toHaveBeenCalledWith(123, 'document-a'));
    });

    it('should propagate a compiled tool registration settlement failure', async () => {
      mockChrome.scripting.executeScript
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('registration rejected'));

      await expect(
        (lifecycle as any).injectBuiltInTools(123, 'https://www.youtube.com/watch?v=test')
      ).rejects.toThrow('registration rejected');
      expect(mockChrome.scripting.executeScript).toHaveBeenCalledTimes(2);
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

    it('should skip URLs outside manifest permissions and protected extension stores', async () => {
      const unsupportedUrls = [
        'chrome://extensions',
        'chrome-extension://abc123',
        'about:blank',
        'file:///tmp/example.html',
        'http://example.com',
        'https://chromewebstore.google.com/detail/example/abc123',
        'https://chrome.google.com/webstore/detail/example/abc123',
        'https://microsoftedge.microsoft.com/addons/detail/example/abc123',
      ];

      for (const url of unsupportedUrls) {
        mockChrome.tabs.get.mockResolvedValue({ id: 123, url });
        await lifecycle.injectScripts(123);
      }

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

    it('should reject a pending catalog refresh when the page reports unavailable', async () => {
      let messageHandler: ((message: unknown) => void) | undefined;
      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 }, documentId: 'document-a' },
        onMessage: {
          addListener: vi.fn((handler) => {
            messageHandler = handler;
          }),
        },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
      };
      portHandlers.onConnect(mockPort);
      const pending = lifecycle.requestToolsAndWait(123);

      messageHandler?.({
        type: 'webmcp',
        payload: {
          method: 'tools/listChanged',
          params: {
            tools: [],
            origin: 'https://example.com',
            unavailable: true,
          },
        },
      });

      await expect(pending).rejects.toThrow('page tool catalog is unavailable');
      expect(lifecycle.getToolRegistry(123)).toBeUndefined();
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

      // Find the tools/call request (first call is tools/list, second is tools/call)
      const toolCallRequest = mockPort.postMessage.mock.calls.find(
        (call) => call[0]?.payload?.method === 'tools/call'
      );

      expect(toolCallRequest).toBeDefined();
      expect(toolCallRequest![0]).toMatchObject({
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
      const requestId = toolCallRequest![0].payload.id;

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

    it('rejects failed delivery without replaying into a replacement route', async () => {
      vi.useFakeTimers();
      const makePort = () => ({
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 }, documentId: 'same-document' },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      });
      const failedPort = makePort();
      failedPort.postMessage.mockImplementation((message) => {
        if (message?.payload?.method === 'tools/call') throw new Error('disconnected port');
      });
      portHandlers.onConnect(failedPort);

      const controller = new AbortController();
      const promise = lifecycle.callTool(123, 'one-shot-tool', {}, controller.signal);

      await expect(promise).rejects.toThrow('Tool call delivery failed');
      expect(
        failedPort.postMessage.mock.calls.filter(
          (call) => call[0]?.payload?.method === 'tools/call'
        )
      ).toHaveLength(1);

      const replacementPort = makePort();
      portHandlers.onConnect(replacementPort);
      controller.abort(new Error('late abort'));
      vi.advanceTimersByTime(10001);

      expect(
        replacementPort.postMessage.mock.calls.some(
          (call) =>
            call[0]?.payload?.method === 'tools/call' || call[0]?.payload?.method === 'tools/cancel'
        )
      ).toBe(false);
      expect(
        failedPort.postMessage.mock.calls.some(
          (call) => call[0]?.payload?.method === 'tools/cancel'
        )
      ).toBe(false);
      vi.useRealTimers();
    });

    it('does not transfer pending calls or stale disconnects to a replacement port', async () => {
      const makePort = () => ({
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 }, documentId: 'same-document' },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      });
      const oldPort = makePort();
      const replacementPort = makePort();
      portHandlers.onConnect(oldPort);
      const oldDisconnectHandler = oldPort.onDisconnect.addListener.mock.calls[0][0];
      const oldPromise = lifecycle.callTool(123, 'old-route-tool', {});
      const oldRequestId = oldPort.postMessage.mock.calls.find(
        (call) => call[0]?.payload?.method === 'tools/call'
      )![0].payload.id;
      const oldRejection = expect(oldPromise).rejects.toThrow('Tool call cancelled');

      portHandlers.onConnect(replacementPort);
      const replacementMessageHandler = replacementPort.onMessage.addListener.mock.calls[0][0];
      replacementMessageHandler({
        type: 'webmcp',
        payload: { jsonrpc: '2.0', id: oldRequestId, result: 'wrong-route' },
      });

      await oldRejection;
      expect(oldPort.postMessage).toHaveBeenCalledWith({
        type: 'webmcp',
        payload: {
          jsonrpc: '2.0',
          method: 'tools/cancel',
          params: { id: oldRequestId },
        },
      });
      expect(
        replacementPort.postMessage.mock.calls.some(
          (call) => call[0]?.payload?.method === 'tools/cancel'
        )
      ).toBe(false);

      const currentPromise = lifecycle.callTool(123, 'current-route-tool', {});
      const currentRequestId = replacementPort.postMessage.mock.calls.find(
        (call) => call[0]?.payload?.method === 'tools/call'
      )![0].payload.id;
      oldDisconnectHandler();
      replacementMessageHandler({
        type: 'webmcp',
        payload: { jsonrpc: '2.0', id: currentRequestId, result: 'current-route' },
      });

      await expect(currentPromise).resolves.toBe('current-route');
    });

    it('settles concurrent calls by request ID when responses arrive out of order', async () => {
      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };
      let messageHandler: ((message: unknown) => void) | undefined;
      mockPort.onMessage.addListener.mockImplementation((handler) => {
        messageHandler = handler;
      });
      portHandlers.onConnect(mockPort);

      const first = lifecycle.callTool(123, 'first', {});
      const second = lifecycle.callTool(123, 'second', {});
      const third = lifecycle.callTool(123, 'third', {});
      const calls = mockPort.postMessage.mock.calls
        .map(([message]) => message.payload)
        .filter(({ method }) => method === 'tools/call');
      const requestByName = new Map(calls.map((call) => [call.params.name, call.id]));

      for (const name of ['second', 'third', 'first']) {
        messageHandler?.({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestByName.get(name),
            result: `${name}-result`,
          },
        });
      }

      await expect(Promise.all([first, second, third])).resolves.toEqual([
        'first-result',
        'second-result',
        'third-result',
      ]);
    });

    it('should not let another tab settle a pending call by request ID', async () => {
      const makePort = (tabId: number) => ({
        name: 'webmcp-content-script',
        sender: { tab: { id: tabId }, documentId: `document-${tabId}` },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      });
      const ownerPort = makePort(123);
      const otherPort = makePort(456);
      portHandlers.onConnect(ownerPort);
      portHandlers.onConnect(otherPort);
      const ownerHandler = ownerPort.onMessage.addListener.mock.calls[0][0];
      const otherHandler = otherPort.onMessage.addListener.mock.calls[0][0];
      const promise = lifecycle.callTool(123, 'owned-tool', {});
      const requestId = ownerPort.postMessage.mock.calls.find(
        (call) => call[0]?.payload?.method === 'tools/call'
      )![0].payload.id;

      otherHandler({
        type: 'webmcp',
        payload: { jsonrpc: '2.0', id: requestId, result: 'wrong-tab' },
      });
      ownerHandler({
        type: 'webmcp',
        payload: { jsonrpc: '2.0', id: requestId, result: 'owning-tab' },
      });

      await expect(promise).resolves.toBe('owning-tab');
    });

    it.each([{ code: -32000, message: 'secret page-controlled failure' }, null, false, 0])(
      'should reject every response containing an error member',
      async (responseError) => {
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

        // Find the tools/call request (not the tools/list request)
        const toolCallRequest = mockPort.postMessage.mock.calls.find(
          (call) => call[0]?.payload?.method === 'tools/call'
        );

        expect(toolCallRequest).toBeDefined();
        const requestId = toolCallRequest![0].payload.id;

        // Send error response
        if (messageHandler) {
          (messageHandler as Function)({
            type: 'webmcp',
            payload: {
              jsonrpc: '2.0',
              id: requestId,
              error: responseError,
            },
          });
        }

        await expect(promise).rejects.toThrow('WebMCP tool execution failed');
      }
    );

    it('should forward an AI cancellation signal to the page', async () => {
      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };
      portHandlers.onConnect(mockPort);

      const controller = new AbortController();
      const reason = new Error('stream cancelled');
      const promise = lifecycle.callTool(123, 'slow-tool', {}, controller.signal);
      const requestId = mockPort.postMessage.mock.calls.find(
        (call) => call[0]?.payload?.method === 'tools/call'
      )![0].payload.id;

      controller.abort(reason);

      await expect(promise).rejects.toBe(reason);
      expect(mockPort.postMessage).toHaveBeenCalledWith({
        type: 'webmcp',
        payload: {
          jsonrpc: '2.0',
          method: 'tools/cancel',
          params: { id: requestId },
        },
      });
    });

    it('should cancel pending calls on their owning port before a new document takes over', async () => {
      const makePort = (documentId: string) => ({
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 }, documentId },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      });
      const oldPort = makePort('old-document');
      const newPort = makePort('new-document');
      portHandlers.onConnect(oldPort);

      const promise = lifecycle.callTool(123, 'slow-tool', {});
      const requestId = oldPort.postMessage.mock.calls.find(
        (call) => call[0]?.payload?.method === 'tools/call'
      )![0].payload.id;
      navHandlers.onBeforeNavigate({ tabId: 123, frameId: 0 });
      portHandlers.onConnect(newPort);

      await expect(promise).rejects.toThrow('Tool call cancelled');
      expect(oldPort.postMessage).toHaveBeenCalledWith({
        type: 'webmcp',
        payload: {
          jsonrpc: '2.0',
          method: 'tools/cancel',
          params: { id: requestId },
        },
      });
      expect(
        newPort.postMessage.mock.calls.some((call) => call[0]?.payload?.method === 'tools/cancel')
      ).toBe(false);
    });

    it('should cancel unresolved calls when their document relay disconnects', async () => {
      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 }, documentId: 'closed-document' },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };
      portHandlers.onConnect(mockPort);
      const disconnectHandler = mockPort.onDisconnect.addListener.mock.calls[0][0];
      const promise = lifecycle.callTool(123, 'slow-tool', {});

      disconnectHandler();

      await expect(promise).rejects.toThrow('Tool call cancelled');
    });

    it('should cancel page execution when a tool call times out', async () => {
      vi.useFakeTimers();
      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };
      portHandlers.onConnect(mockPort);

      const promise = lifecycle.callTool(123, 'slow-tool', {});
      const requestId = mockPort.postMessage.mock.calls.find(
        (call) => call[0]?.payload?.method === 'tools/call'
      )![0].payload.id;

      vi.advanceTimersByTime(10001);

      await expect(promise).rejects.toThrow('Tool call timeout');
      expect(mockPort.postMessage).toHaveBeenCalledWith({
        type: 'webmcp',
        payload: {
          jsonrpc: '2.0',
          method: 'tools/cancel',
          params: { id: requestId },
        },
      });
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

  describe('Service Worker Hibernation Recovery', () => {
    it('should request tools when port connects to recover from hibernation', () => {
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

      // Should send tools/list request after connection
      // The first call is for pending messages flush, second is tools/list request
      const toolsListCall = mockPort.postMessage.mock.calls.find((call) => {
        return call[0]?.payload?.method === 'tools/list';
      });

      expect(toolsListCall).toBeDefined();
      expect(toolsListCall![0]).toMatchObject({
        type: 'webmcp',
        payload: {
          jsonrpc: '2.0',
          method: 'tools/list',
          params: {},
        },
      });
      expect(toolsListCall![0].payload).not.toHaveProperty('id');
    });

    it('should recover tools after service worker hibernation', () => {
      // Simulate initial connection with tools
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

      let messageHandler: Function | null = null;
      mockPort.onMessage.addListener = vi.fn((handler) => {
        messageHandler = handler;
      });

      // First connection
      portHandlers.onConnect(mockPort);

      // Page sends tools
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

      // Verify tools are registered
      let registry = lifecycle.getToolRegistry(123);
      expect(registry).toBeDefined();
      expect(registry?.tools).toHaveLength(2);

      // SIMULATE SERVICE WORKER HIBERNATION
      // Create a new TabManager instance (simulates SW restart with empty state)
      lifecycle = new TabManager();

      // Registry should be empty now (state lost)
      registry = lifecycle.getToolRegistry(123);
      expect(registry).toBeUndefined();

      // Port reconnects (content script still alive)
      const newPort = {
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

      let reconnectHandler: Function | null = null;
      newPort.onMessage.addListener = vi.fn((handler) => {
        reconnectHandler = handler;
      });

      portHandlers.onConnect(newPort);

      // Should have requested tools
      const toolsRequest = newPort.postMessage.mock.calls.find(
        (call) => call[0]?.payload?.method === 'tools/list'
      );
      expect(toolsRequest).toBeDefined();

      // Page responds with tools
      if (reconnectHandler) {
        (reconnectHandler as Function)({
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

      // Tools should be recovered!
      registry = lifecycle.getToolRegistry(123);
      expect(registry).toBeDefined();
      expect(registry?.tools).toHaveLength(2);
      expect(registry?.tools[0].name).toBe('tool1');
    });

    it('should wait for tools when requesting with requestToolsAndWait', async () => {
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

      let messageHandler: Function | null = null;
      mockPort.onMessage.addListener = vi.fn((handler) => {
        messageHandler = handler;
      });

      // Connect port
      portHandlers.onConnect(mockPort);

      // Clear the initial tools/list request
      mockPort.postMessage.mockClear();

      // Request tools and wait for response
      const toolsPromise = lifecycle.requestToolsAndWait(123);

      // Verify tools/list request was sent
      expect(mockPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'webmcp',
          payload: expect.objectContaining({
            method: 'tools/list',
          }),
        })
      );

      // Simulate page sending tools
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

      // Promise should resolve with tools
      const tools = await toolsPromise;
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('tool1');
    });

    it('should request tools on every port connection', () => {
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

      // First connection
      portHandlers.onConnect(mockPort);

      const firstCallCount = mockPort.postMessage.mock.calls.filter(
        (call) => call[0]?.payload?.method === 'tools/list'
      ).length;

      expect(firstCallCount).toBe(1);

      // Disconnect and reconnect
      const disconnectHandler = mockPort.onDisconnect.addListener.mock.calls[0][0];
      disconnectHandler();

      const mockPort2 = {
        ...mockPort,
        postMessage: vi.fn(),
      };

      portHandlers.onConnect(mockPort2);

      // Should send tools/list request on every connection
      const secondCallCount = mockPort2.postMessage.mock.calls.filter(
        (call) => call[0]?.payload?.method === 'tools/list'
      ).length;

      expect(secondCallCount).toBe(1);
    });
  });

  describe('waitForNavigation', () => {
    it('should resolve when onCompleted fires for main frame', async () => {
      // Capture the onCompleted/onErrorOccurred listeners added by waitForNavigation
      const completedListeners: Function[] = [];
      const errorListeners: Function[] = [];

      (mockChrome.webNavigation as any).onCompleted = {
        addListener: vi.fn((handler: Function) => completedListeners.push(handler)),
        removeListener: vi.fn(),
      };
      (mockChrome.webNavigation as any).onErrorOccurred = {
        addListener: vi.fn((handler: Function) => errorListeners.push(handler)),
        removeListener: vi.fn(),
      };

      const promise = lifecycle.waitForNavigation(123);

      // Simulate onCompleted for main frame
      for (const listener of completedListeners) {
        listener({ tabId: 123, frameId: 0, url: 'https://example.com/new' });
      }

      const result = await promise;
      expect(result).toEqual({ url: 'https://example.com/new' });
    });

    it('should ignore subframe completions', async () => {
      const completedListeners: Function[] = [];
      const errorListeners: Function[] = [];

      (mockChrome.webNavigation as any).onCompleted = {
        addListener: vi.fn((handler: Function) => completedListeners.push(handler)),
        removeListener: vi.fn(),
      };
      (mockChrome.webNavigation as any).onErrorOccurred = {
        addListener: vi.fn((handler: Function) => errorListeners.push(handler)),
        removeListener: vi.fn(),
      };

      const promise = lifecycle.waitForNavigation(123, 500);

      // Subframe completion — should be ignored
      for (const listener of completedListeners) {
        listener({ tabId: 123, frameId: 1, url: 'https://example.com/iframe' });
      }

      // Different tab — should be ignored
      for (const listener of completedListeners) {
        listener({ tabId: 999, frameId: 0, url: 'https://other.com' });
      }

      // Now fire main frame
      for (const listener of completedListeners) {
        listener({ tabId: 123, frameId: 0, url: 'https://example.com/actual' });
      }

      const result = await promise;
      expect(result).toEqual({ url: 'https://example.com/actual' });
    });

    it('should reject on navigation error', async () => {
      const completedListeners: Function[] = [];
      const errorListeners: Function[] = [];

      (mockChrome.webNavigation as any).onCompleted = {
        addListener: vi.fn((handler: Function) => completedListeners.push(handler)),
        removeListener: vi.fn(),
      };
      (mockChrome.webNavigation as any).onErrorOccurred = {
        addListener: vi.fn((handler: Function) => errorListeners.push(handler)),
        removeListener: vi.fn(),
      };

      const promise = lifecycle.waitForNavigation(123);

      // Simulate navigation error
      for (const listener of errorListeners) {
        listener({ tabId: 123, frameId: 0, url: 'https://bad-url.com' });
      }

      await expect(promise).rejects.toThrow('Navigation failed for tab 123');
    });

    it('should remove navigation listeners when the stream is cancelled', async () => {
      const onCompleted = { addListener: vi.fn(), removeListener: vi.fn() };
      const onErrorOccurred = { addListener: vi.fn(), removeListener: vi.fn() };
      (mockChrome.webNavigation as any).onCompleted = onCompleted;
      (mockChrome.webNavigation as any).onErrorOccurred = onErrorOccurred;
      const controller = new AbortController();
      const promise = lifecycle.waitForNavigation(123, 30000, controller.signal);

      controller.abort();

      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      expect(onCompleted.removeListener).toHaveBeenCalledOnce();
      expect(onErrorOccurred.removeListener).toHaveBeenCalledOnce();
    });

    it('should timeout after specified duration', async () => {
      vi.useFakeTimers();

      (mockChrome.webNavigation as any).onCompleted = {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      };
      (mockChrome.webNavigation as any).onErrorOccurred = {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      };

      const promise = lifecycle.waitForNavigation(123, 1000);

      vi.advanceTimersByTime(1001);

      await expect(promise).rejects.toThrow('Navigation timeout after 1000ms');

      vi.useRealTimers();
    });
  });

  describe('Navigation clears stale tool registry', () => {
    it('should clear tool registry on onBeforeNavigate', () => {
      // First, populate a tool registry for the tab
      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 123 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      let messageHandler: Function | null = null;
      mockPort.onMessage.addListener = vi.fn((handler) => {
        messageHandler = handler;
      });

      portHandlers.onConnect(mockPort);

      // Register tools
      if (messageHandler) {
        (messageHandler as Function)({
          type: 'webmcp',
          payload: {
            method: 'tools/listChanged',
            params: {
              tools: [{ name: 'old_tool', description: 'Tool from old page' }],
              origin: 'https://old-page.com',
            },
          },
        });
      }

      expect(lifecycle.getToolRegistry(123)).toBeDefined();
      expect(lifecycle.getToolRegistry(123)?.tools).toHaveLength(1);

      // Trigger navigation — should clear registry
      navHandlers.onBeforeNavigate({ tabId: 123, frameId: 0 });

      expect(lifecycle.getToolRegistry(123)).toBeUndefined();

      // Messages already queued by the old document must not restore its catalog after navigation.
      (messageHandler as unknown as Function)({
        type: 'webmcp',
        payload: {
          method: 'tools/listChanged',
          params: {
            tools: [{ name: 'stale_tool', description: 'Stale tool' }],
            origin: 'https://old-page.com',
          },
        },
      });
      expect(lifecycle.getToolRegistry(123)).toBeUndefined();
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

      // Verify injection order after the manifest-owned polyfill.
      // 1. Relay FIRST (must be listening when bridge sends initial snapshot)
      expect(calls[0][0]).toEqual({
        target: { tabId: 123, frameIds: [0] },
        world: 'ISOLATED',
        injectImmediately: true,
        files: ['content-scripts/relay.js'],
      });

      // 2. Bridge LAST (after relay is ready; no page-owned tool matches this URL)
      expect(calls[1][0]).toEqual({
        target: { tabId: 123, frameIds: [0] },
        world: 'MAIN',
        injectImmediately: false,
        files: ['content-scripts/page-bridge.js'],
      });
    });

    it('should serialize overlapping script operations for the same tab', async () => {
      mockChrome.tabs.get.mockResolvedValue({
        id: 123,
        url: 'https://example.com',
      });
      let releaseFirst!: () => void;
      mockChrome.scripting.executeScript
        .mockImplementationOnce(() => new Promise<void>((resolve) => (releaseFirst = resolve)))
        .mockResolvedValue(undefined);

      const first = lifecycle.injectScripts(123);
      await Promise.resolve();
      await Promise.resolve();
      const second = lifecycle.injectScripts(123);
      await Promise.resolve();

      expect(mockChrome.tabs.get).toHaveBeenCalledTimes(1);
      releaseFirst();
      await first;
      await second;
      expect(mockChrome.tabs.get).toHaveBeenCalledTimes(2);
    });

    it('should handle injection errors gracefully', async () => {
      mockChrome.tabs.get.mockResolvedValue({
        id: 123,
        url: 'https://example.com',
      });

      mockChrome.scripting.executeScript.mockRejectedValue(new Error('Cannot access tab'));

      await expect(lifecycle.injectScripts(123)).resolves.toBeUndefined();
      expect(mockChrome.scripting.executeScript).toHaveBeenCalled();
    });
  });
});
