import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

describe('Shopify MCP Bootstrap Tool', () => {
  let mockWindow: any;
  let mockFetch: any;
  let registeredTools: Map<string, any>;

  beforeEach(() => {
    registeredTools = new Map();

    mockWindow = {
      Shopify: undefined,
      __shopifyMCPBootstrapped: undefined,
      location: {
        hostname: 'test-store.myshopify.com',
        protocol: 'https:',
      },
      agent: {
        registerTool: vi.fn((tool) => {
          registeredTools.set(tool.name, tool);
        }),
      },
    };

    mockFetch = vi.fn();

    global.window = mockWindow as any;
    global.fetch = mockFetch as any;
    global.console = {
      ...console,
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as any;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('shouldRegister', () => {
    it('should return false when not on a Shopify site', async () => {
      // Import and execute shouldRegister
      // @ts-ignore - importing JS module for testing
      // @ts-ignore - importing JS module for testing
      const scriptModule = await import('../src/lib/webmcp/tools/shopify_bootstrap/script.js');
      const shouldReg = scriptModule.shouldRegister();

      expect(shouldReg).toBe(false);
      expect(mockWindow.__shopifyMCPBootstrapped).toBeUndefined();
    });

    it('should return false but start discovery on Shopify site', async () => {
      mockWindow.Shopify = { shop: 'test-store.myshopify.com' };

      // Mock successful tools/list response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          result: {
            tools: [
              {
                name: 'search_shop_catalog',
                description: 'Search product catalog',
                inputSchema: {
                  type: 'object',
                  properties: {
                    query: { type: 'string' },
                  },
                },
              },
            ],
          },
        }),
      });

      // @ts-ignore - importing JS module for testing
      const scriptModule = await import('../src/lib/webmcp/tools/shopify_bootstrap/script.js');
      const shouldReg = scriptModule.shouldRegister();

      expect(shouldReg).toBe(false);
      expect(mockWindow.__shopifyMCPBootstrapped).toBe(true);

      // Wait for async discovery to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test-store.myshopify.com/api/mcp',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('should not run discovery twice', async () => {
      mockWindow.Shopify = { shop: 'test-store.myshopify.com' };
      mockWindow.__shopifyMCPBootstrapped = true;

      // @ts-ignore - importing JS module for testing
      const scriptModule = await import('../src/lib/webmcp/tools/shopify_bootstrap/script.js');
      const shouldReg = scriptModule.shouldRegister();

      expect(shouldReg).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('tool discovery', () => {
    it('should register discovered tools with shopify_ prefix', async () => {
      mockWindow.Shopify = { shop: 'test-store.myshopify.com' };

      // Mock successful tools/list response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          result: {
            tools: [
              {
                name: 'search_shop_catalog',
                description: 'Search products',
                inputSchema: { type: 'object' },
              },
              {
                name: 'get_cart',
                description: 'Get cart contents',
                inputSchema: { type: 'object' },
              },
            ],
          },
        }),
      });

      // Clear module cache to get fresh import
      const modulePath = '../src/lib/webmcp/tools/shopify_bootstrap/script.js';
      // @ts-ignore - accessing require for module cache
      delete require.cache[require.resolve(modulePath)];

      // @ts-ignore - importing JS module for testing
      const scriptModule = await import(modulePath);
      scriptModule.shouldRegister();

      // Wait for async discovery
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockWindow.agent.registerTool).toHaveBeenCalledTimes(2);
      expect(registeredTools.has('shopify_search_shop_catalog')).toBe(true);
      expect(registeredTools.has('shopify_get_cart')).toBe(true);
    });

    it('should handle text-wrapped JSON response', async () => {
      mockWindow.Shopify = { shop: 'test-store.myshopify.com' };

      // Mock Shopify's text-wrapped JSON format
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  tools: [
                    {
                      name: 'search_shop_catalog',
                      description: 'Search products',
                    },
                  ],
                }),
              },
            ],
          },
        }),
      });

      const modulePath = '../src/lib/webmcp/tools/shopify_bootstrap/script.js';
      delete require.cache[require.resolve(modulePath)];

      const scriptModule = await import(modulePath);
      scriptModule.shouldRegister();

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(registeredTools.has('shopify_search_shop_catalog')).toBe(true);
    });

    it('should reset flag on error to allow retry', async () => {
      mockWindow.Shopify = { shop: 'test-store.myshopify.com' };

      // Mock failed response
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const modulePath = '../src/lib/webmcp/tools/shopify_bootstrap/script.js';
      delete require.cache[require.resolve(modulePath)];

      const scriptModule = await import(modulePath);
      scriptModule.shouldRegister();

      expect(mockWindow.__shopifyMCPBootstrapped).toBe(true);

      // Wait for async discovery to fail
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Flag should be reset after error
      expect(mockWindow.__shopifyMCPBootstrapped).toBe(false);
      expect(global.console.error).toHaveBeenCalledWith(
        '[Shopify Bootstrap] Failed to discover tools:',
        expect.any(Error)
      );
    });
  });

  describe('registered tool execution', () => {
    it('should proxy tool calls to MCP endpoint', async () => {
      mockWindow.Shopify = { shop: 'test-store.myshopify.com' };

      // Mock tools/list response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          result: {
            tools: [
              {
                name: 'search_shop_catalog',
                description: 'Search products',
                inputSchema: {
                  type: 'object',
                  properties: {
                    query: { type: 'string' },
                  },
                },
              },
            ],
          },
        }),
      });

      const modulePath = '../src/lib/webmcp/tools/shopify_bootstrap/script.js';
      delete require.cache[require.resolve(modulePath)];

      const scriptModule = await import(modulePath);
      scriptModule.shouldRegister();

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Get the registered tool
      const searchTool = registeredTools.get('shopify_search_shop_catalog');
      expect(searchTool).toBeDefined();

      // Mock successful tool execution
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ products: [] }),
              },
            ],
          },
        }),
      });

      // Execute the tool
      const result = await searchTool.execute({ query: 'shoes' });

      // Verify it called MCP with correct parameters
      expect(mockFetch).toHaveBeenLastCalledWith(
        'https://test-store.myshopify.com/api/mcp',
        expect.objectContaining({
          body: expect.stringContaining('"name":"search_shop_catalog"'),
        })
      );

      // Verify response transformation
      expect(result.content[0].type).toBe('json');
      expect(result.content[0].json).toEqual({ products: [] });
    });
  });
});
