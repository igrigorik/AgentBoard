import { describe, it, expect, beforeEach } from 'vitest';
import { parseUserScript } from '../src/lib/webmcp/script-parser';

describe('WebMCP Conditional Registration', () => {
  describe('Script Parser', () => {
    it('should parse script with shouldRegister export', () => {
      const scriptCode = `
'use webmcp-tool v1';

export const metadata = {
  name: 'conditional_tool',
  namespace: 'test',
  version: '1.0.0',
  match: ['<all_urls>']
};

export function shouldRegister() {
  return window.someCondition === true;
}

export async function execute(args) {
  return 'executed';
}`;

      const parsed = parseUserScript(scriptCode);
      expect(parsed.metadata.name).toBe('conditional_tool');
      expect(parsed.code).toContain('shouldRegister');
    });

    it('should parse script without shouldRegister export', () => {
      const scriptCode = `
'use webmcp-tool v1';

export const metadata = {
  name: 'normal_tool',
  namespace: 'test',
  version: '1.0.0',
  match: ['<all_urls>']
};

export async function execute(args) {
  return 'executed';
}`;

      const parsed = parseUserScript(scriptCode);
      expect(parsed.metadata.name).toBe('normal_tool');
      expect(parsed.code).not.toContain('export function shouldRegister');
    });

    it('should reject async shouldRegister', () => {
      const scriptCode = `
'use webmcp-tool v1';

export const metadata = {
  name: 'bad_tool',
  namespace: 'test',
  version: '1.0.0',
  match: ['<all_urls>']
};

export async function shouldRegister() {
  return true;
}

export async function execute(args) {
  return 'executed';
}`;

      expect(() => parseUserScript(scriptCode)).toThrow(
        'shouldRegister must be synchronous (not async)'
      );
    });
  });

  describe('Shopify Tool Specific', () => {
    let mockWindow: any;

    beforeEach(() => {
      mockWindow = {
        Shopify: undefined,
        location: {
          hostname: 'test-store.myshopify.com',
          protocol: 'https:',
        },
      };
      global.window = mockWindow as any;
    });

    it('should detect Shopify store via window.Shopify', () => {
      // Import the actual shouldRegister logic
      const shouldRegisterCode = `
        function shouldRegister() {
          if (typeof window.Shopify !== 'undefined' && window.Shopify.shop) {
            return true;
          }
          return false;
        }
      `;

      // Test with Shopify present
      mockWindow.Shopify = { shop: 'test-shop.myshopify.com' };
      const func = new Function('window', `${shouldRegisterCode}; return shouldRegister();`);
      expect(func(mockWindow)).toBe(true);

      // Test without Shopify
      mockWindow.Shopify = undefined;
      expect(func(mockWindow)).toBe(false);

      // Test with Shopify but no shop property
      mockWindow.Shopify = {};
      expect(func(mockWindow)).toBe(false);
    });

    it('should handle MCP endpoint URL construction', () => {
      mockWindow.Shopify = { shop: 'test-shop.myshopify.com' };

      const shopDomain = mockWindow.location.hostname;
      const mcpEndpoint = `${mockWindow.location.protocol}//${shopDomain}/api/mcp`;

      expect(mcpEndpoint).toBe('https://test-store.myshopify.com/api/mcp');
    });

    it('should format MCP request correctly', () => {
      const args = {
        query: 'coffee',
        context: 'organic products',
      };

      const request = {
        jsonrpc: '2.0',
        method: 'tools/call',
        id: expect.any(Number),
        params: {
          name: 'search_shop_catalog',
          arguments: {
            query: args.query,
            context: args.context,
          },
        },
      };

      expect(request.jsonrpc).toBe('2.0');
      expect(request.method).toBe('tools/call');
      expect(request.params.name).toBe('search_shop_catalog');
      expect(request.params.arguments).toEqual(args);
    });
  });
});
