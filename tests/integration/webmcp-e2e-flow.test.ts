/**
 * End-to-end integration tests for WebMCP
 * Tests complete message flow: sidebar → background → content → MAIN world → back
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TabManager } from '../../src/lib/webmcp/lifecycle';
import { convertWebMCPToAISDKTool } from '../../src/lib/webmcp/tool-bridge';

describe('WebMCP E2E Message Flow', () => {
  let mockChrome: any;
  let lifecycleManager: TabManager;
  let messageHandlers: {
    runtime?: Function;
    port?: Function;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    messageHandlers = {};

    // Setup comprehensive Chrome mock
    mockChrome = {
      runtime: {
        onMessage: {
          addListener: vi.fn((handler: Function) => {
            messageHandlers.runtime = handler;
          }),
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
          get: vi.fn().mockResolvedValue({
            aiConfig: { provider: 'openai', model: 'gpt-4' },
            mcpServers: [],
          }),
          set: vi.fn().mockResolvedValue(undefined),
        },
        session: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
      tabs: {
        get: vi.fn((tabId: number) => Promise.resolve({ id: tabId, url: 'https://example.com' })),
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
      sidePanel: {
        open: vi.fn().mockResolvedValue(undefined),
        setOptions: vi.fn().mockResolvedValue(undefined),
      },
      action: {
        onClicked: {
          addListener: vi.fn(),
        },
      },
    };

    (global as any).chrome = mockChrome;

    // Mock crypto
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

    // Initialize components
    lifecycleManager = new TabManager();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.clearAllMocks();
  });

  describe('Complete Tool Discovery Flow', () => {
    it('should handle full tool discovery from page to sidebar', async () => {
      const tabId = 123;

      // Step 1: Simulate sidebar opening and requesting tab binding
      // Not used in this test but would be in actual flow
      // const sidebarBinding = { type: 'get-bound-tab' };
      // const sidebarSender = {
      //   url: `chrome-extension://ext-id/sidebar.html#tab=${tabId}`,
      //   id: 'sidebar-frame',
      // };

      // Step 2: Connect content script
      const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];
      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: tabId } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      let portMessageHandler: ((msg: any) => void) | null = null;
      mockPort.onMessage.addListener = vi.fn((handler) => {
        portMessageHandler = handler;
      });

      onConnectHandler(mockPort);

      // Step 3: Page reports tools via tools/listChanged
      const pageTools = [
        {
          name: 'page-tool-1',
          description: 'First page tool',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
        {
          name: 'page-tool-2',
          description: 'Second page tool',
        },
      ];

      if (portMessageHandler) {
        (portMessageHandler as (msg: any) => void)({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            method: 'tools/listChanged',
            params: {
              tools: pageTools,
              origin: 'https://example.com',
            },
          },
        });
      }

      // Step 4: Verify tools are registered in lifecycle manager
      const registry = lifecycleManager.getToolRegistry(tabId);
      expect(registry).toBeDefined();
      expect(registry?.tools).toHaveLength(2);
      expect(registry?.tools[0].name).toBe('page-tool-1');
      expect(registry?.tools[1].name).toBe('page-tool-2');

      // Step 5: Verify tools are converted correctly to AI SDK format
      const sdkTool1 = convertWebMCPToAISDKTool(pageTools[0], tabId);
      expect(sdkTool1).toBeDefined();
      expect(sdkTool1.description).toBe('First page tool');
    });

    it('should merge tools from multiple sources', async () => {
      const tabId = 456;

      // Setup content script connection
      const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];
      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: tabId } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      let portMessageHandler: ((msg: any) => void) | null = null;
      mockPort.onMessage.addListener = vi.fn((handler) => {
        portMessageHandler = handler;
      });

      onConnectHandler(mockPort);

      // Add site tools
      if (portMessageHandler) {
        (portMessageHandler as (msg: any) => void)({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            method: 'tools/listChanged',
            params: {
              tools: [
                { name: 'site-tool-1', description: 'Site tool 1' },
                { name: 'site-tool-2', description: 'Site tool 2' },
              ],
              origin: 'https://example.com',
            },
          },
        });
      }

      // Update with merged tools (simulated - page would merge all)
      if (portMessageHandler) {
        (portMessageHandler as (msg: any) => void)({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            method: 'tools/listChanged',
            params: {
              tools: [
                { name: 'site-tool-1', description: 'Site tool 1' },
                { name: 'site-tool-2', description: 'Site tool 2' },
                { name: 'user-tool-1', description: 'User script tool' },
              ],
              origin: 'https://example.com',
            },
          },
        });
      }

      // Verify all tools are in lifecycle manager registry
      const registry = lifecycleManager.getToolRegistry(tabId);
      expect(registry).toBeDefined();
      expect(registry?.tools).toHaveLength(3);
      expect(registry?.tools.some((t) => t.name === 'site-tool-1')).toBe(true);
      expect(registry?.tools.some((t) => t.name === 'site-tool-2')).toBe(true);
      expect(registry?.tools.some((t) => t.name === 'user-tool-1')).toBe(true);
    });
  });

  describe('Complete Tool Execution Flow', () => {
    it('should execute tool from sidebar through all layers', async () => {
      const tabId = 789;

      // Setup content script connection
      const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];
      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: tabId } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      let portMessageHandler: ((msg: any) => void) | null = null;
      mockPort.onMessage.addListener = vi.fn((handler) => {
        portMessageHandler = handler;
      });

      onConnectHandler(mockPort);

      // Register a tool
      if (portMessageHandler) {
        (portMessageHandler as (msg: any) => void)({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            method: 'tools/listChanged',
            params: {
              tools: [
                {
                  name: 'test-e2e-tool',
                  description: 'E2E test tool',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      input: { type: 'string' },
                    },
                    required: ['input'],
                  },
                },
              ],
              origin: 'https://example.com',
            },
          },
        });
      }

      // Step 1: Sidebar initiates tool call via lifecycle manager
      const executePromise = lifecycleManager.callTool(tabId, 'test-e2e-tool', {
        input: 'test-value',
      });

      // Step 2: Verify message sent to content script
      expect(mockPort.postMessage).toHaveBeenCalledWith({
        type: 'webmcp',
        payload: expect.objectContaining({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'test-e2e-tool',
            arguments: { input: 'test-value' },
          },
        }),
      });

      // Get request ID (find tools/call message, skip tools/list from requestToolsFromTab)
      const toolCallIndex = mockPort.postMessage.mock.calls.findIndex(
        (call: any) => call[0].payload.method === 'tools/call'
      );
      const request = mockPort.postMessage.mock.calls[toolCallIndex][0];
      const requestId = request.payload.id;

      // Step 3: Simulate page executing tool and returning result
      if (portMessageHandler) {
        (portMessageHandler as (msg: any) => void)({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            result: {
              content: [
                { type: 'text', text: 'Tool executed successfully' },
                { type: 'json', json: { processed: 'test-value' } },
              ],
            },
          },
        });
      }

      // Step 4: Verify result flows back to sidebar
      const result = await executePromise;
      expect(result).toEqual({
        content: [
          { type: 'text', text: 'Tool executed successfully' },
          { type: 'json', json: { processed: 'test-value' } },
        ],
      });
    });

    it('should handle tool execution errors through all layers', async () => {
      const tabId = 321;

      // Setup connection
      const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];
      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: tabId } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      let portMessageHandler: ((msg: any) => void) | null = null;
      mockPort.onMessage.addListener = vi.fn((handler) => {
        portMessageHandler = handler;
      });

      onConnectHandler(mockPort);

      // Register tool
      if (portMessageHandler) {
        (portMessageHandler as (msg: any) => void)({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            method: 'tools/listChanged',
            params: {
              tools: [{ name: 'error-tool', description: 'Tool that errors' }],
              origin: 'https://example.com',
            },
          },
        });
      }

      // Execute tool
      const executePromise = lifecycleManager.callTool(tabId, 'error-tool', {});

      // Get request ID (find tools/call message, skip tools/list from requestToolsFromTab)
      const toolCallIndex = mockPort.postMessage.mock.calls.findIndex(
        (call: any) => call[0].payload.method === 'tools/call'
      );
      const request = mockPort.postMessage.mock.calls[toolCallIndex][0];
      const requestId = request.payload.id;

      // Return error
      if (portMessageHandler) {
        (portMessageHandler as (msg: any) => void)({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            error: {
              code: -32000,
              message: 'Execution failed: Database connection error',
            },
          },
        });
      }

      // Verify error propagates
      await expect(executePromise).rejects.toThrow('Execution failed: Database connection error');
    });
  });

  describe('Tab Lifecycle Integration', () => {
    it('should handle complete tab lifecycle from open to close', async () => {
      const tabId = 999;
      const onTabRemovedHandler = mockChrome.tabs.onRemoved.addListener.mock.calls[0]?.[0];

      // Step 1: Open sidebar (simulates user clicking extension icon)
      await mockChrome.sidePanel.open({ tabId });

      // Step 2: Content script connects
      const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];
      const mockPort = {
        name: 'webmcp-content-script',
        sender: { tab: { id: tabId } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      let portMessageHandler: ((msg: any) => void) | null = null;

      mockPort.onMessage.addListener = vi.fn((handler) => {
        portMessageHandler = handler;
      });
      mockPort.onDisconnect.addListener = vi.fn(() => {
        // Disconnect handler not needed in this test
      });

      onConnectHandler(mockPort);

      // Step 3: Tools registered
      if (portMessageHandler) {
        (portMessageHandler as (msg: any) => void)({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            method: 'tools/listChanged',
            params: {
              tools: [{ name: 'tab-tool', description: 'Tab-specific tool' }],
              origin: 'https://example.com',
            },
          },
        });
      }

      // Verify tools registered
      const registry = lifecycleManager.getToolRegistry(tabId);
      expect(registry?.tools).toHaveLength(1);

      // Step 4: Execute a tool
      const toolPromise = lifecycleManager.callTool(tabId, 'tab-tool', {});
      // Find tools/call message (skip tools/list from requestToolsFromTab)
      const toolCallIndex = mockPort.postMessage.mock.calls.findIndex(
        (call: any) => call[0].payload.method === 'tools/call'
      );
      const request = mockPort.postMessage.mock.calls[toolCallIndex][0];

      // Return result
      if (portMessageHandler) {
        (portMessageHandler as (msg: any) => void)({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: request.payload.id,
            result: 'success',
          },
        });
      }

      await expect(toolPromise).resolves.toBe('success');

      // Step 5: Tab closes
      if (onTabRemovedHandler) {
        onTabRemovedHandler(tabId);
      }

      // Verify cleanup
      expect(lifecycleManager.getToolRegistry(tabId)).toBeUndefined();

      // New tool calls should fail
      await expect(lifecycleManager.callTool(tabId, 'tab-tool', {})).rejects.toThrow();
    });

    it('should handle navigation within same tab', async () => {
      const tabId = 555;

      // Get the onConnect handler that was registered by the existing lifecycle manager
      const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];
      expect(onConnectHandler).toBeDefined();

      // Get navigation handlers
      const onBeforeNavigate =
        mockChrome.webNavigation.onBeforeNavigate.addListener.mock.calls[0]?.[0];
      const onDOMContentLoaded =
        mockChrome.webNavigation.onDOMContentLoaded.addListener.mock.calls[0]?.[0];
      const mockPort1 = {
        name: 'webmcp-content-script',
        sender: { tab: { id: tabId } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      let portMessageHandler1: ((msg: any) => void) | null = null;
      let disconnectHandler1: (() => void) | null = null;

      mockPort1.onMessage.addListener = vi.fn((handler) => {
        portMessageHandler1 = handler;
      });
      mockPort1.onDisconnect.addListener = vi.fn((handler) => {
        disconnectHandler1 = handler;
      });

      onConnectHandler(mockPort1);

      // Register tools on first page
      if (portMessageHandler1) {
        (portMessageHandler1 as (msg: any) => void)({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            method: 'tools/listChanged',
            params: {
              tools: [{ name: 'page1-tool', description: 'First page tool' }],
              origin: 'https://example.com/page1',
            },
          },
        });
      }

      // Start navigation
      if (onBeforeNavigate) {
        onBeforeNavigate({
          tabId,
          frameId: 0,
          url: 'https://example.com/page2',
        });
      }

      // Disconnect old port
      if (disconnectHandler1) {
        (disconnectHandler1 as () => void)();
      }

      // DOM ready on new page
      if (onDOMContentLoaded) {
        await onDOMContentLoaded({
          tabId,
          frameId: 0,
          url: 'https://example.com/page2',
        });
      }

      // Verify scripts re-injected
      expect(mockChrome.scripting.executeScript).toHaveBeenCalled();

      // New connection from new page
      const mockPort2 = {
        name: 'webmcp-content-script',
        sender: { tab: { id: tabId } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      let portMessageHandler2: ((msg: any) => void) | null = null;
      mockPort2.onMessage.addListener.mockImplementation((handler) => {
        portMessageHandler2 = handler;
      });

      // Connect the new port
      onConnectHandler(mockPort2);

      // Now send the new tools from page2
      if (portMessageHandler2) {
        (portMessageHandler2 as (msg: any) => void)({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            method: 'tools/listChanged',
            params: {
              tools: [{ name: 'page2-tool', description: 'Second page tool' }],
              origin: 'https://example.com/page2',
            },
          },
        });
      }

      // Verify new tools replaced old ones
      const registry = lifecycleManager.getToolRegistry(tabId);
      expect(registry).toBeDefined();
      expect(registry!.tools).toHaveLength(1);
      expect(registry!.tools[0].name).toBe('page2-tool');
      expect(registry!.origin).toBe('https://example.com/page2');
    });
  });

  describe('Multi-Tab Scenarios', () => {
    it('should isolate tools between different tabs', async () => {
      const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];

      // Tab 1 connection
      const mockPort1 = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 111 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      let portMessageHandler1: ((msg: any) => void) | null = null;
      mockPort1.onMessage.addListener = vi.fn((handler) => {
        portMessageHandler1 = handler;
      });

      onConnectHandler(mockPort1);

      // Tab 2 connection
      const mockPort2 = {
        name: 'webmcp-content-script',
        sender: { tab: { id: 222 } },
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };

      let portMessageHandler2: ((msg: any) => void) | null = null;
      mockPort2.onMessage.addListener = vi.fn((handler) => {
        portMessageHandler2 = handler;
      });

      onConnectHandler(mockPort2);

      // Register different tools in each tab
      if (portMessageHandler1) {
        (portMessageHandler1 as (msg: any) => void)({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            method: 'tools/listChanged',
            params: {
              tools: [{ name: 'tab1-specific', description: 'Only in tab 1' }],
              origin: 'https://site1.com',
            },
          },
        });
      }

      if (portMessageHandler2) {
        (portMessageHandler2 as (msg: any) => void)({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            method: 'tools/listChanged',
            params: {
              tools: [{ name: 'tab2-specific', description: 'Only in tab 2' }],
              origin: 'https://site2.com',
            },
          },
        });
      }

      // Verify isolation
      const registry1 = lifecycleManager.getToolRegistry(111);
      const registry2 = lifecycleManager.getToolRegistry(222);

      expect(registry1?.tools[0].name).toBe('tab1-specific');
      expect(registry2?.tools[0].name).toBe('tab2-specific');
      expect(registry1?.origin).toBe('https://site1.com');
      expect(registry2?.origin).toBe('https://site2.com');

      // Execute tools on correct tabs
      void lifecycleManager.callTool(111, 'tab1-specific', {});
      void lifecycleManager.callTool(222, 'tab2-specific', {});

      // Verify messages went to correct ports
      expect(mockPort1.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'webmcp',
          payload: expect.objectContaining({
            params: { name: 'tab1-specific', arguments: {} },
          }),
        })
      );

      expect(mockPort2.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'webmcp',
          payload: expect.objectContaining({
            params: { name: 'tab2-specific', arguments: {} },
          }),
        })
      );
    });
  });
});
