/**
 * Integration tests for WebMCP tool execution with various return types
 * Tests the complete flow for different tool output formats
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TabManager } from '../../src/lib/webmcp/lifecycle';

describe('WebMCP Tool Execution Integration', () => {
  let mockChrome: any;
  let lifecycleManager: TabManager;
  let mockPort: any;
  let portMessageHandler: Function | null = null;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup Chrome mock
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

    // Initialize lifecycle manager
    lifecycleManager = new TabManager();

    // Setup standard port connection
    const onConnectHandler = mockChrome.runtime.onConnect.addListener.mock.calls[0]?.[0];
    mockPort = {
      name: 'webmcp-content-script',
      sender: { tab: { id: 123 } },
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };

    portMessageHandler = null;
    mockPort.onMessage.addListener = vi.fn((handler) => {
      portMessageHandler = handler;
    });

    onConnectHandler(mockPort);
  });

  describe('Simple Return Types', () => {
    it('should handle string return values', async () => {
      const toolCallPromise = lifecycleManager.callTool(123, 'string-tool', { input: 'test' });

      // Get request ID from sent message
      // Find tools/call message (skip tools/list from requestToolsFromTab)
      const toolCallIndex = mockPort.postMessage.mock.calls.findIndex(
        (call: any) => call[0].payload.method === 'tools/call'
      );
      const request = mockPort.postMessage.mock.calls[toolCallIndex][0];
      const requestId = request.payload.id;

      // Simulate string response
      if (portMessageHandler) {
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            result: 'Simple string response',
          },
        });
      }

      const result = await toolCallPromise;
      expect(result).toBe('Simple string response');
    });

    it('should handle number return values', async () => {
      const toolCallPromise = lifecycleManager.callTool(123, 'math-tool', { x: 5, y: 3 });

      // Find tools/call message (skip tools/list from requestToolsFromTab)
      const toolCallIndex = mockPort.postMessage.mock.calls.findIndex(
        (call: any) => call[0].payload.method === 'tools/call'
      );
      const request = mockPort.postMessage.mock.calls[toolCallIndex][0];
      const requestId = request.payload.id;

      if (portMessageHandler) {
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            result: 42,
          },
        });
      }

      const result = await toolCallPromise;
      expect(result).toBe(42);
    });

    it('should handle boolean return values', async () => {
      const toolCallPromise = lifecycleManager.callTool(123, 'check-tool', { condition: 'test' });

      // Find tools/call message (skip tools/list from requestToolsFromTab)
      const toolCallIndex = mockPort.postMessage.mock.calls.findIndex(
        (call: any) => call[0].payload.method === 'tools/call'
      );
      const request = mockPort.postMessage.mock.calls[toolCallIndex][0];
      const requestId = request.payload.id;

      if (portMessageHandler) {
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            result: true,
          },
        });
      }

      const result = await toolCallPromise;
      expect(result).toBe(true);
    });

    it('should handle null return values', async () => {
      const toolCallPromise = lifecycleManager.callTool(123, 'null-tool', {});

      // Find tools/call message (skip tools/list from requestToolsFromTab)
      const toolCallIndex = mockPort.postMessage.mock.calls.findIndex(
        (call: any) => call[0].payload.method === 'tools/call'
      );
      const request = mockPort.postMessage.mock.calls[toolCallIndex][0];
      const requestId = request.payload.id;

      if (portMessageHandler) {
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            result: null,
          },
        });
      }

      const result = await toolCallPromise;
      expect(result).toBeNull();
    });
  });

  describe('Complex Return Types', () => {
    it('should handle object return values', async () => {
      const toolCallPromise = lifecycleManager.callTool(123, 'object-tool', {});

      // Find tools/call message (skip tools/list from requestToolsFromTab)
      const toolCallIndex = mockPort.postMessage.mock.calls.findIndex(
        (call: any) => call[0].payload.method === 'tools/call'
      );
      const request = mockPort.postMessage.mock.calls[toolCallIndex][0];
      const requestId = request.payload.id;

      const complexObject = {
        name: 'Test Object',
        value: 42,
        nested: {
          array: [1, 2, 3],
          flag: true,
        },
      };

      if (portMessageHandler) {
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            result: complexObject,
          },
        });
      }

      const result = await toolCallPromise;
      expect(result).toEqual(complexObject);
    });

    it('should handle array return values', async () => {
      const toolCallPromise = lifecycleManager.callTool(123, 'array-tool', {});

      // Find tools/call message (skip tools/list from requestToolsFromTab)
      const toolCallIndex = mockPort.postMessage.mock.calls.findIndex(
        (call: any) => call[0].payload.method === 'tools/call'
      );
      const request = mockPort.postMessage.mock.calls[toolCallIndex][0];
      const requestId = request.payload.id;

      const arrayResult = [
        { id: 1, name: 'Item 1' },
        { id: 2, name: 'Item 2' },
        { id: 3, name: 'Item 3' },
      ];

      if (portMessageHandler) {
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            result: arrayResult,
          },
        });
      }

      const result = await toolCallPromise;
      expect(result).toEqual(arrayResult);
    });

    it('should handle MCP-style content blocks', async () => {
      const toolCallPromise = lifecycleManager.callTool(123, 'content-tool', {});

      // Find tools/call message (skip tools/list from requestToolsFromTab)
      const toolCallIndex = mockPort.postMessage.mock.calls.findIndex(
        (call: any) => call[0].payload.method === 'tools/call'
      );
      const request = mockPort.postMessage.mock.calls[toolCallIndex][0];
      const requestId = request.payload.id;

      const mcpContent = {
        content: [
          { type: 'text', text: 'Here is some text' },
          { type: 'json', json: { data: 'structured' } },
          { type: 'image', data: 'base64data', mimeType: 'image/png' },
        ],
      };

      if (portMessageHandler) {
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            result: mcpContent,
          },
        });
      }

      const result = await toolCallPromise;
      expect(result).toEqual(mcpContent);
    });

    it('should handle deeply nested structures', async () => {
      const toolCallPromise = lifecycleManager.callTool(123, 'nested-tool', {});

      // Find tools/call message (skip tools/list from requestToolsFromTab)
      const toolCallIndex = mockPort.postMessage.mock.calls.findIndex(
        (call: any) => call[0].payload.method === 'tools/call'
      );
      const request = mockPort.postMessage.mock.calls[toolCallIndex][0];
      const requestId = request.payload.id;

      const deeplyNested = {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: {
                  value: 'deep value',
                  array: [1, [2, [3, [4, [5]]]]],
                },
              },
            },
          },
        },
      };

      if (portMessageHandler) {
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            result: deeplyNested,
          },
        });
      }

      const result = await toolCallPromise;
      expect(result).toEqual(deeplyNested);
    });
  });

  describe('Error Handling', () => {
    it('should handle tool execution errors', async () => {
      const toolCallPromise = lifecycleManager.callTool(123, 'error-tool', {});

      // Find tools/call message (skip tools/list from requestToolsFromTab)
      const toolCallIndex = mockPort.postMessage.mock.calls.findIndex(
        (call: any) => call[0].payload.method === 'tools/call'
      );
      const request = mockPort.postMessage.mock.calls[toolCallIndex][0];
      const requestId = request.payload.id;

      if (portMessageHandler) {
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            error: {
              code: -32000,
              message: 'Tool execution failed: Something went wrong',
              data: { details: 'Additional error info' },
            },
          },
        });
      }

      await expect(toolCallPromise).rejects.toThrow('Tool execution failed: Something went wrong');
    });

    it('should handle validation errors', async () => {
      const toolCallPromise = lifecycleManager.callTool(123, 'validated-tool', {
        invalidArg: true,
      });

      // Find tools/call message (skip tools/list from requestToolsFromTab)
      const toolCallIndex = mockPort.postMessage.mock.calls.findIndex(
        (call: any) => call[0].payload.method === 'tools/call'
      );
      const request = mockPort.postMessage.mock.calls[toolCallIndex][0];
      const requestId = request.payload.id;

      if (portMessageHandler) {
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            error: {
              code: -32602,
              message: 'Invalid params: Missing required field "requiredField"',
            },
          },
        });
      }

      await expect(toolCallPromise).rejects.toThrow(
        'Invalid params: Missing required field "requiredField"'
      );
    });

    it('should handle tool not found errors', async () => {
      const toolCallPromise = lifecycleManager.callTool(123, 'nonexistent-tool', {});

      // Find tools/call message (skip tools/list from requestToolsFromTab)
      const toolCallIndex = mockPort.postMessage.mock.calls.findIndex(
        (call: any) => call[0].payload.method === 'tools/call'
      );
      const request = mockPort.postMessage.mock.calls[toolCallIndex][0];
      const requestId = request.payload.id;

      if (portMessageHandler) {
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            error: {
              code: -32601,
              message: 'Tool not found: nonexistent-tool',
            },
          },
        });
      }

      await expect(toolCallPromise).rejects.toThrow('Tool not found: nonexistent-tool');
    });

    it('should handle timeout errors', async () => {
      vi.useFakeTimers();

      const toolCallPromise = lifecycleManager.callTool(123, 'slow-tool', {});

      // Fast forward past timeout (10 seconds)
      vi.advanceTimersByTime(11000);

      await expect(toolCallPromise).rejects.toThrow('Tool call timeout');

      vi.useRealTimers();
    });
  });

  describe('Concurrent Tool Calls', () => {
    it('should handle multiple concurrent tool calls', async () => {
      // Start multiple tool calls
      const promise1 = lifecycleManager.callTool(123, 'tool1', { arg: 'a' });
      const promise2 = lifecycleManager.callTool(123, 'tool2', { arg: 'b' });
      const promise3 = lifecycleManager.callTool(123, 'tool3', { arg: 'c' });

      // Get all tool call request IDs (skip tools/list from requestToolsFromTab)
      const requests = mockPort.postMessage.mock.calls
        .filter((call: any) => call[0].payload.method === 'tools/call')
        .map((call: any) => ({
          id: call[0].payload.id,
          name: call[0].payload.params.name,
        }));

      // Respond to all in different order
      if (portMessageHandler) {
        // Respond to tool2 first
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requests[1].id,
            result: 'result2',
          },
        });

        // Then tool3
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requests[2].id,
            result: 'result3',
          },
        });

        // Finally tool1
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requests[0].id,
            result: 'result1',
          },
        });
      }

      // All promises should resolve with correct results
      expect(await promise1).toBe('result1');
      expect(await promise2).toBe('result2');
      expect(await promise3).toBe('result3');
    });

    it('should handle mixed success and failure in concurrent calls', async () => {
      // Start multiple tool calls
      const promise1 = lifecycleManager.callTool(123, 'tool1', {});
      const promise2 = lifecycleManager.callTool(123, 'tool2', {});
      const promise3 = lifecycleManager.callTool(123, 'tool3', {});

      // Get all tool call request IDs (skip tools/list from requestToolsFromTab)
      const requests = mockPort.postMessage.mock.calls
        .filter((call: any) => call[0].payload.method === 'tools/call')
        .map((call: any) => ({
          id: call[0].payload.id,
          name: call[0].payload.params.name,
        }));

      if (portMessageHandler) {
        // tool1 succeeds
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requests[0].id,
            result: 'success1',
          },
        });

        // tool2 fails
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requests[1].id,
            error: { code: -32000, message: 'Failed tool2' },
          },
        });

        // tool3 succeeds
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requests[2].id,
            result: 'success3',
          },
        });
      }

      // Check results
      expect(await promise1).toBe('success1');
      await expect(promise2).rejects.toThrow('Failed tool2');
      expect(await promise3).toBe('success3');
    });
  });

  describe('Large Payloads', () => {
    it('should handle large string payloads', async () => {
      // Create a large string (1MB)
      const largeString = 'x'.repeat(1024 * 1024);

      const toolCallPromise = lifecycleManager.callTool(123, 'large-tool', { data: largeString });

      // Find tools/call message (skip tools/list from requestToolsFromTab)
      const toolCallIndex = mockPort.postMessage.mock.calls.findIndex(
        (call: any) => call[0].payload.method === 'tools/call'
      );
      const request = mockPort.postMessage.mock.calls[toolCallIndex][0];
      const requestId = request.payload.id;

      // Return large string
      if (portMessageHandler) {
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            result: largeString,
          },
        });
      }

      const result = await toolCallPromise;
      expect(result).toBe(largeString);
    });

    it('should handle large array payloads', async () => {
      // Create large array (10k items)
      const largeArray = Array.from({ length: 10000 }, (_, i) => ({
        id: i,
        value: `Item ${i}`,
        data: { nested: true, index: i },
      }));

      const toolCallPromise = lifecycleManager.callTool(123, 'array-processor', {});

      // Find tools/call message (skip tools/list from requestToolsFromTab)
      const toolCallIndex = mockPort.postMessage.mock.calls.findIndex(
        (call: any) => call[0].payload.method === 'tools/call'
      );
      const request = mockPort.postMessage.mock.calls[toolCallIndex][0];
      const requestId = request.payload.id;

      if (portMessageHandler) {
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            result: largeArray,
          },
        });
      }

      const result = await toolCallPromise;
      expect(result).toEqual(largeArray);
      expect((result as any[]).length).toBe(10000);
    });
  });

  describe('Special Characters and Encoding', () => {
    it('should handle Unicode and emoji in payloads', async () => {
      const unicodeData = {
        text: '🎉 Unicode test 你好世界 مرحبا بالعالم',
        emoji: '🚀🔥💯',
        special: '©®™€£¥',
      };

      const toolCallPromise = lifecycleManager.callTool(123, 'unicode-tool', unicodeData);

      // Find tools/call message (skip tools/list from requestToolsFromTab)
      const toolCallIndex = mockPort.postMessage.mock.calls.findIndex(
        (call: any) => call[0].payload.method === 'tools/call'
      );
      const request = mockPort.postMessage.mock.calls[toolCallIndex][0];
      const requestId = request.payload.id;

      if (portMessageHandler) {
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            result: unicodeData,
          },
        });
      }

      const result = await toolCallPromise;
      expect(result).toEqual(unicodeData);
    });

    it('should handle HTML and script content safely', async () => {
      const htmlContent = {
        html: '<script>alert("XSS")</script><div>Safe content</div>',
        js: 'console.log("This is JavaScript code");',
        json: '{"key": "value", "nested": {"array": [1,2,3]}}',
      };

      const toolCallPromise = lifecycleManager.callTool(123, 'html-tool', htmlContent);

      // Find tools/call message (skip tools/list from requestToolsFromTab)
      const toolCallIndex = mockPort.postMessage.mock.calls.findIndex(
        (call: any) => call[0].payload.method === 'tools/call'
      );
      const request = mockPort.postMessage.mock.calls[toolCallIndex][0];
      const requestId = request.payload.id;

      if (portMessageHandler) {
        portMessageHandler({
          type: 'webmcp',
          payload: {
            jsonrpc: '2.0',
            id: requestId,
            result: htmlContent,
          },
        });
      }

      const result = await toolCallPromise;
      expect(result).toEqual(htmlContent);
    });
  });
});
