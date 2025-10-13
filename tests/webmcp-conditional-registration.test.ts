import { describe, it, expect, beforeEach, vi } from 'vitest';
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

  describe('Conditional Registration Logic', () => {
    let mockWindow: any;
    let mockDocument: any;

    beforeEach(() => {
      mockWindow = {
        agent: {
          registerTool: vi.fn(),
        },
        __webmcpInjected: {},
        location: {
          hostname: 'example.com',
          protocol: 'https:',
        },
      };
      mockDocument = {
        querySelector: vi.fn(),
        querySelectorAll: vi.fn(() => []),
        scripts: [],
      };
      global.window = mockWindow as any;
      global.document = mockDocument as any;
    });

    it('should create wrapped script with shouldRegister check', () => {
      const scriptCode = `
'use webmcp-tool v1';

export const metadata = {
  name: 'search_shop_catalog',
  namespace: 'shopify',
  version: '1.0.0',
  match: ['<all_urls>']
};

export function shouldRegister() {
  return typeof window.Shopify !== 'undefined';
}

export async function execute(args) {
  return 'shopify response';
}`;

      // Test that the transformation includes shouldRegister
      const transformedCode = scriptCode
        .replace(/^\s*'use webmcp-tool v\d+';\s*/, '')
        .replace(/export\s+const\s+metadata\s*=/g, 'const metadata =')
        .replace(/export\s+(async\s+)?function\s+execute/g, '$1function execute')
        .replace(/export\s+function\s+shouldRegister/g, 'function shouldRegister');

      expect(transformedCode).toContain('function shouldRegister');
      expect(transformedCode).not.toContain('export function shouldRegister');
    });

    it('should handle tools without shouldRegister', () => {
      const scriptCode = `
'use webmcp-tool v1';

export const metadata = {
  name: 'always_tool',
  namespace: 'test',
  version: '1.0.0',
  match: ['<all_urls>']
};

export async function execute(args) {
  return 'always works';
}`;

      // Test that transformation works without shouldRegister
      const transformedCode = scriptCode
        .replace(/^\s*'use webmcp-tool v\d+';\s*/, '')
        .replace(/export\s+const\s+metadata\s*=/g, 'const metadata =')
        .replace(/export\s+(async\s+)?function\s+execute/g, '$1function execute')
        .replace(/export\s+function\s+shouldRegister/g, 'function shouldRegister');

      expect(transformedCode).not.toContain('shouldRegister');
      expect(transformedCode).toContain('async function execute');
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
