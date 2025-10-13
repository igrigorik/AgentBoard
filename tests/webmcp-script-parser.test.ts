/**
 * Unit tests for WebMCP script parser
 */

import { describe, it, expect } from 'vitest';
import {
  parseUserScript,
  matchesUrl,
  createScriptTemplate,
  validateScript,
  ScriptParsingError,
} from '../src/lib/webmcp/script-parser';

describe('WebMCP Script Parser', () => {
  describe('parseUserScript', () => {
    it('should parse a valid script with pragma and metadata', () => {
      const script = `'use webmcp-tool v1';

export const metadata = {
  name: "test_tool",
  namespace: "test",
  version: "1.0.0",
  description: "Test tool",
  match: "<all_urls>"
};

export async function execute(args) {
  return "test result";
}`;

      const result = parseUserScript(script);
      expect(result.metadata.name).toBe('test_tool');
      expect(result.metadata.namespace).toBe('test');
      expect(result.metadata.version).toBe('1.0.0');
      expect(result.metadata.description).toBe('Test tool');
      expect(result.metadata.match).toEqual(['<all_urls>']);
      expect(result.code).toBe(script);
    });

    it('should handle array match patterns', () => {
      const script = `'use webmcp-tool v1';

export const metadata = {
  name: "multi_match",
  namespace: "test",
  version: "1.0.0",
  match: ["https://example.com/*", "https://test.com/*"],
  exclude: ["*://localhost/*"]
};

export function execute(args) {
  return "test";
}`;

      const result = parseUserScript(script);
      expect(result.metadata.match).toEqual(['https://example.com/*', 'https://test.com/*']);
      expect(result.metadata.exclude).toEqual(['*://localhost/*']);
    });

    it('should parse script with inputSchema', () => {
      const script = `'use webmcp-tool v1';

export const metadata = {
  name: "schema_tool",
  namespace: "test",
  version: "1.0.0",
  match: "<all_urls>",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", default: 10 }
    },
    required: ["query"],
    additionalProperties: false
  }
};

export async function execute(args) {
  return args.query;
}`;

      const result = parseUserScript(script);
      expect(result.metadata.inputSchema).toEqual({
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', default: 10 },
        },
        required: ['query'],
        additionalProperties: false,
      });
    });

    it('should throw error for missing pragma', () => {
      const script = `export const metadata = {
  name: "no_pragma",
  namespace: "test",
  version: "1.0.0",
  match: "<all_urls>"
};

export function execute(args) {
  return "test";
}`;

      expect(() => parseUserScript(script)).toThrow(ScriptParsingError);
      expect(() => parseUserScript(script)).toThrow(/Missing pragma/);
    });

    it('should throw error for unsupported pragma version', () => {
      const script = `'use webmcp-tool v2';

export const metadata = {
  name: "wrong_version",
  namespace: "test",
  version: "1.0.0",
  match: "<all_urls>"
};

export function execute(args) {
  return "test";
}`;

      expect(() => parseUserScript(script)).toThrow(/Unsupported pragma version: v2/);
    });

    it('should throw error for missing metadata export', () => {
      const script = `'use webmcp-tool v1';

const metadata = {
  name: "no-export",
  version: "1.0.0",
  match: "<all_urls>"
};

export function execute(args) {
  return "test";
}`;

      expect(() => parseUserScript(script)).toThrow(/Missing export: metadata/);
    });

    it('should throw error for missing execute export', () => {
      const script = `'use webmcp-tool v1';

export const metadata = {
  name: "no_execute",
  namespace: "test",
  version: "1.0.0",
  match: "<all_urls>"
};

function execute(args) {
  return "test";
}`;

      expect(() => parseUserScript(script)).toThrow(/Missing export: execute function/);
    });

    it('should throw error for missing required metadata fields', () => {
      const scriptNoName = `'use webmcp-tool v1';

export const metadata = {
  namespace: "test",
  version: "1.0.0",
  match: "<all_urls>"
};

export function execute(args) {
  return "test";
}`;

      expect(() => parseUserScript(scriptNoName)).toThrow(/Missing or invalid "name"/);

      const scriptNoVersion = `'use webmcp-tool v1';

export const metadata = {
  name: "test",
  namespace: "test",
  match: "<all_urls>"
};

export function execute(args) {
  return "test";
}`;

      expect(() => parseUserScript(scriptNoVersion)).toThrow(/Missing or invalid "version"/);

      const scriptNoMatch = `'use webmcp-tool v1';

export const metadata = {
  name: "test",
  namespace: "test",
  version: "1.0.0"
};

export function execute(args) {
  return "test";
}`;

      expect(() => parseUserScript(scriptNoMatch)).toThrow(/Missing "match" patterns/);
    });

    it('should handle comments and whitespace before pragma', () => {
      const script = `// This is a comment
// Another comment

'use webmcp-tool v1';

export const metadata = {
  name: "comment_test",
  namespace: "test",
  version: "1.0.0",
  match: "<all_urls>"
};

export function execute(args) {
  return "test";
}`;

      const result = parseUserScript(script);
      expect(result.metadata.name).toBe('comment_test');
    });

    it('should handle template literals in metadata', () => {
      const script = `'use webmcp-tool v1';

export const metadata = {
  name: "template_test",
  namespace: "test",
  version: "1.0.0",
  description: \`This is a template literal description\`,
  match: "<all_urls>"
};

export function execute(args) {
  return "test";
}`;

      const result = parseUserScript(script);
      expect(result.metadata.description).toBe('This is a template literal description');
    });
  });

  describe('namespace and snake_case validation', () => {
    it('should require namespace field', () => {
      const script = `'use webmcp-tool v1';

export const metadata = {
  name: "test_tool",
  version: "1.0.0",
  match: "<all_urls>"
};

export function execute(args) {
  return "test";
}`;

      expect(() => parseUserScript(script)).toThrow('Namespace is required for all tools');
    });

    it('should validate snake_case format for tool names', () => {
      const script = `'use webmcp-tool v1';

export const metadata = {
  name: "test-tool",
  namespace: "custom",
  version: "1.0.0",
  match: "<all_urls>"
};

export function execute(args) {
  return "test";
}`;

      expect(() => parseUserScript(script)).toThrow('Tool name must be snake_case');
    });

    it('should validate snake_case format for namespace', () => {
      const script = `'use webmcp-tool v1';

export const metadata = {
  name: "test_tool",
  namespace: "my-namespace",
  version: "1.0.0",
  match: "<all_urls>"
};

export function execute(args) {
  return "test";
}`;

      expect(() => parseUserScript(script)).toThrow('Namespace must be snake_case');
    });

    it('should reject reserved agentboard namespace', () => {
      const script = `'use webmcp-tool v1';

export const metadata = {
  name: "test_tool",
  namespace: "agentboard",
  version: "1.0.0",
  match: "<all_urls>"
};

export function execute(args) {
  return "test";
}`;

      expect(() => parseUserScript(script)).toThrow(
        'Reserved namespace: agentboard is reserved for built-in tools'
      );
    });

    it('should accept valid snake_case names and namespaces', () => {
      const script = `'use webmcp-tool v1';

export const metadata = {
  name: "my_awesome_tool",
  namespace: "custom_vendor",
  version: "1.0.0",
  match: "<all_urls>"
};

export function execute(args) {
  return "test";
}`;

      const result = parseUserScript(script);
      expect(result.metadata.name).toBe('my_awesome_tool');
      expect(result.metadata.namespace).toBe('custom_vendor');
    });
  });

  describe('matchesUrl', () => {
    const metadata = {
      name: 'test',
      namespace: 'test',
      version: '1.0.0',
      match: 'https://example.com/*',
    };

    it('should match exact domain with wildcard path', () => {
      expect(matchesUrl('https://example.com/page', metadata)).toBe(true);
      expect(matchesUrl('https://example.com/page/subpage', metadata)).toBe(true);
      expect(matchesUrl('https://example.com/', metadata)).toBe(true);
    });

    it('should not match different protocol', () => {
      expect(matchesUrl('http://example.com/page', metadata)).toBe(false);
    });

    it('should not match different domain', () => {
      expect(matchesUrl('https://test.com/page', metadata)).toBe(false);
    });

    it('should handle <all_urls> pattern', () => {
      const allUrlsMeta = {
        ...metadata,
        match: '<all_urls>',
      };
      expect(matchesUrl('https://example.com/page', allUrlsMeta)).toBe(true);
      expect(matchesUrl('http://test.com/page', allUrlsMeta)).toBe(true);
      expect(matchesUrl('file:///path/to/file', allUrlsMeta)).toBe(false);
    });

    it('should handle wildcard subdomain', () => {
      const wildcardMeta = {
        ...metadata,
        match: 'https://*.example.com/*',
      };
      expect(matchesUrl('https://sub.example.com/page', wildcardMeta)).toBe(true);
      expect(matchesUrl('https://deep.sub.example.com/page', wildcardMeta)).toBe(true);
      expect(matchesUrl('https://example.com/page', wildcardMeta)).toBe(false);
    });

    it('should handle multiple match patterns', () => {
      const multiMeta = {
        ...metadata,
        match: ['https://example.com/*', 'https://test.com/*'],
      };
      expect(matchesUrl('https://example.com/page', multiMeta)).toBe(true);
      expect(matchesUrl('https://test.com/page', multiMeta)).toBe(true);
      expect(matchesUrl('https://other.com/page', multiMeta)).toBe(false);
    });

    it('should handle exclude patterns', () => {
      const excludeMeta = {
        ...metadata,
        match: '<all_urls>',
        exclude: ['*://localhost/*', '*://127.0.0.1/*'],
      };
      expect(matchesUrl('https://example.com/page', excludeMeta)).toBe(true);
      expect(matchesUrl('http://localhost/page', excludeMeta)).toBe(false);
      expect(matchesUrl('http://127.0.0.1/page', excludeMeta)).toBe(false);
    });

    it('should handle protocol wildcard', () => {
      const protocolMeta = {
        ...metadata,
        match: '*://example.com/*',
      };
      expect(matchesUrl('https://example.com/page', protocolMeta)).toBe(true);
      expect(matchesUrl('http://example.com/page', protocolMeta)).toBe(true);
    });

    it('should handle specific paths', () => {
      const pathMeta = {
        ...metadata,
        match: 'https://example.com/api/*',
      };
      expect(matchesUrl('https://example.com/api/users', pathMeta)).toBe(true);
      expect(matchesUrl('https://example.com/api/', pathMeta)).toBe(true);
      expect(matchesUrl('https://example.com/page', pathMeta)).toBe(false);
    });
  });

  describe('createScriptTemplate', () => {
    it('should create a valid script template', () => {
      const template = createScriptTemplate();
      expect(template).toContain("'use webmcp-tool v1'");
      expect(template).toContain('export const metadata');
      expect(template).toContain('export async function execute');

      // Template should be parseable
      const parsed = parseUserScript(template);
      expect(parsed.metadata.name).toBe('my_tool');
      expect(parsed.metadata.namespace).toBe('custom');
      expect(parsed.metadata.version).toBe('0.1.0');
    });
  });

  describe('validateScript', () => {
    it('should validate a correct script', () => {
      const script = `'use webmcp-tool v1';

export const metadata = {
  name: "valid_tool",
  namespace: "test",
  version: "1.0.0",
  description: "A valid tool",
  match: "<all_urls>"
};

export function execute(args) {
  return "valid";
}`;

      const result = validateScript(script);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should warn about missing description', () => {
      const script = `'use webmcp-tool v1';

export const metadata = {
  name: "no_desc",
  namespace: "test",
  version: "1.0.0",
  match: "<all_urls>"
};

export function execute(args) {
  return "test";
}`;

      const result = validateScript(script);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Warning: No description provided');
    });

    it('should error on invalid version format', () => {
      const script = `'use webmcp-tool v1';

export const metadata = {
  name: "bad_version",
  namespace: "test",
  version: "v1",
  description: "Bad version format",
  match: "<all_urls>"
};

export function execute(args) {
  return "test";
}`;

      const result = validateScript(script);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Version should follow semver format (e.g., 1.0.0)');
    });

    it('should return parsing errors', () => {
      const script = `export const metadata = {
  name: "no_pragma",
  namespace: "test",
  version: "1.0.0",
  match: "<all_urls>"
};

export function execute(args) {
  return "test";
}`;

      const result = validateScript(script);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Missing pragma');
    });
  });

  describe('edge cases', () => {
    it('should handle async execute functions', () => {
      const script = `'use webmcp-tool v1';

export const metadata = {
  name: "async_tool",
  namespace: "test",
  version: "1.0.0",
  match: "<all_urls>"
};

export async function execute(args) {
  await new Promise(r => setTimeout(r, 100));
  return "async result";
}`;

      const result = parseUserScript(script);
      expect(result.metadata.name).toBe('async_tool');
    });

    it('should handle trailing commas in metadata', () => {
      const script = `'use webmcp-tool v1';

export const metadata = {
  name: "trailing_comma",
  namespace: "test",
  version: "1.0.0",
  match: "<all_urls>",
};

export function execute(args) {
  return "test";
}`;

      const result = parseUserScript(script);
      expect(result.metadata.name).toBe('trailing_comma');
    });

    it('should handle single quotes in metadata', () => {
      const script = `'use webmcp-tool v1';

export const metadata = {
  name: 'single_quotes',
  namespace: 'test',
  version: '1.0.0',
  description: 'Tool with single quotes',
  match: '<all_urls>'
};

export function execute(args) {
  return "test";
}`;

      const result = parseUserScript(script);
      expect(result.metadata.name).toBe('single_quotes');
      expect(result.metadata.description).toBe('Tool with single quotes');
    });
  });
});
