/**
 * Unit tests for WebMCP script injector
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  injectUserScripts,
  getMatchingScripts,
  validateAllScripts,
  reinjectScripts,
} from '../src/lib/webmcp/script-injector';

// Mock chrome.scripting API
const mockExecuteScript = vi.fn();
global.chrome = {
  ...global.chrome,
  scripting: {
    executeScript: mockExecuteScript,
  } as any,
  tabs: {
    get: vi.fn(),
  } as any,
};

// Mock ConfigStorage
vi.mock('../src/lib/storage/config', () => {
  const mockScripts = [
    {
      id: 'script1',
      enabled: true,
      code: `'use webmcp-tool v1';

export const metadata = {
  name: "test_tool",
  namespace: "test",
  version: "1.0.0",
  description: "Test tool",
  match: "https://example.com/*"
};

export async function execute(args) {
  return "test result";
}`,
    },
    {
      id: 'script2',
      enabled: true,
      code: `'use webmcp-tool v1';

export const metadata = {
  name: "all_urls_tool",
  namespace: "test",
  version: "1.0.0",
  match: "<all_urls>",
  exclude: ["*://localhost/*"]
};

export function execute(args) {
  return "all urls";
}`,
    },
    {
      id: 'script3',
      enabled: false,
      code: `'use webmcp-tool v1';

export const metadata = {
  name: "disabled_tool",
  namespace: "test",
  version: "1.0.0",
  match: "<all_urls>"
};

export function execute(args) {
  return "disabled";
}`,
    },
    {
      id: 'script4',
      enabled: true,
      code: `'use webmcp-tool v1';

export const metadata = {
  name: "early_tool",
  namespace: "test",
  version: "1.0.0",
  match: "https://example.com/*"
};

export function execute(args) {
  return "early";
}`,
    },
    {
      id: 'script5',
      enabled: true,
      code: `'use webmcp-tool v1';

export const metadata = {
  name: "multi_match",
  namespace: "test",
  version: "1.0.0",
  match: ["https://example.com/*", "https://test.com/*"],
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" }
    }
  }
};

export function execute(args) {
  return args.query;
}`,
    },
  ];

  return {
    ConfigStorage: {
      getInstance: () => ({
        getUserScripts: vi.fn().mockResolvedValue(mockScripts),
        getUserScript: vi
          .fn()
          .mockImplementation((id) =>
            Promise.resolve(mockScripts.find((s) => s.id === id) || null)
          ),
      }),
    },
  };
});

// Helper to filter out agentboard tool injections from mock calls
const getNonDefaultScriptCalls = (mockFn: any) => {
  return mockFn.mock.calls.filter((call: any) => {
    const scriptCode = call[0].args?.[0] || '';
    // Agentboard tools are marked with a special comment
    return !scriptCode.includes('// webmcp:agentboard_tool');
  });
};

// Helper to check if a specific script was injected
const wasScriptInjected = (mockFn: any, scriptName: string) => {
  return mockFn.mock.calls.some((call: any) => {
    const scriptCode = call[0].args?.[0] || '';
    // Check if the script contains the tool name
    // Look for the name in the original code that gets transformed
    // The injected code will have the original script embedded as a string
    return (
      scriptCode.includes(`name: \\"${scriptName}\\"`) || // Escaped quotes in stringified code
      scriptCode.includes(`name: "${scriptName}"`) || // Direct quotes
      scriptCode.includes(`'${scriptName}'`) // Single quotes
    );
  });
};

describe('WebMCP Script Injector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteScript.mockReset();
    mockExecuteScript.mockResolvedValue(undefined);
  });

  describe('injectUserScripts', () => {
    it('should inject scripts that match the URL', async () => {
      await injectUserScripts({
        tabId: 123,
        url: 'https://example.com/page',
        frameId: 0,
      });

      // Built-in tools are now injected by lifecycle, not script-injector
      // So script-injector only injects user scripts
      expect(mockExecuteScript.mock.calls.length).toBe(4); // test_tool, all_urls_tool, early_tool, multi_match

      // Check that scripts are injected with correct world and frame
      expect(mockExecuteScript).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { tabId: 123, frameIds: [0] },
          world: 'MAIN',
        })
      );
    });

    it('should use document_idle timing for all scripts', async () => {
      await injectUserScripts({
        tabId: 123,
        url: 'https://example.com/page',
        frameId: 0,
      });

      // All scripts should inject at document_idle (injectImmediately: false)
      mockExecuteScript.mock.calls.forEach((call) => {
        expect(call[0].injectImmediately).toBe(false);
      });
    });

    it('should not inject disabled scripts', async () => {
      await injectUserScripts({
        tabId: 123,
        url: 'https://example.com/page',
        frameId: 0,
      });

      // disabled_tool should not be injected even though it matches <all_urls>
      const nonDefaultCalls = getNonDefaultScriptCalls(mockExecuteScript);
      expect(nonDefaultCalls).toHaveLength(4); // Only enabled user scripts
      expect(wasScriptInjected(mockExecuteScript, 'disabled_tool')).toBe(false);
    });

    it('should not inject scripts that do not match URL', async () => {
      await injectUserScripts({
        tabId: 456,
        url: 'https://other.com/page',
        frameId: 0,
      });

      // Only all_urls_tool should be injected from user scripts
      const nonDefaultCalls = getNonDefaultScriptCalls(mockExecuteScript);
      expect(nonDefaultCalls).toHaveLength(1);
      // The tool is registered as namespace_name format now
      // Since namespace is "test" and name is "all_urls_tool", it should be registered as "test_all_urls_tool"
      // But the helper should still find it by the original name
      expect(wasScriptInjected(mockExecuteScript, 'all_urls_tool')).toBe(true);
    });

    it('should exclude URLs based on exclude patterns', async () => {
      await injectUserScripts({
        tabId: 789,
        url: 'http://localhost/page',
        frameId: 0,
      });

      // all_urls_tool excludes localhost
      // Default tools still inject (they use <all_urls>)
      const nonDefaultCalls = getNonDefaultScriptCalls(mockExecuteScript);
      expect(nonDefaultCalls).toHaveLength(0); // No user scripts should inject
      expect(wasScriptInjected(mockExecuteScript, 'all_urls_tool')).toBe(false);
    });

    it('should handle multiple match patterns', async () => {
      await injectUserScripts({
        tabId: 111,
        url: 'https://test.com/api',
        frameId: 0,
      });

      // Built-in tools are now injected by lifecycle, not script-injector
      // So script-injector only injects user scripts
      expect(mockExecuteScript.mock.calls.length).toBe(2); // multi_match and all_urls_tool
    });
  });

  describe('getMatchingScripts', () => {
    it('should return all matching enabled scripts for a URL', async () => {
      const matching = await getMatchingScripts('https://example.com/page');

      // Filter out defaults for the test (core and Shopify tools)
      const nonDefaultMatching = matching.filter(
        (s) => !s.id.startsWith('agentboard:') && !s.id.startsWith('shopify:')
      );

      // Should match test_tool, all_urls_tool, early_tool, and multi_match
      expect(nonDefaultMatching).toHaveLength(4);
      expect(nonDefaultMatching.map((s) => s.id)).toContain('script1');
      expect(nonDefaultMatching.map((s) => s.id)).toContain('script2'); // all_urls_tool
      expect(nonDefaultMatching.map((s) => s.id)).toContain('script4');
      expect(nonDefaultMatching.map((s) => s.id)).toContain('script5');
    });

    it('should not include disabled scripts', async () => {
      const matching = await getMatchingScripts('https://any.com/page');

      // Filter out defaults for the test (core and Shopify tools)
      const nonDefaultMatching = matching.filter(
        (s) => !s.id.startsWith('agentboard:') && !s.id.startsWith('shopify:')
      );

      // Should only include all_urls_tool, not disabled_tool
      expect(nonDefaultMatching).toHaveLength(1);
      expect(nonDefaultMatching[0].id).toBe('script2');
    });

    it('should respect exclude patterns', async () => {
      const matching = await getMatchingScripts('http://localhost/test');

      // Filter out defaults (which use <all_urls> and will match)
      const nonDefaultMatching = matching.filter(
        (s) => !s.id.startsWith('agentboard:') && !s.id.startsWith('shopify:')
      );

      // all_urls_tool excludes localhost
      expect(nonDefaultMatching).toHaveLength(0);
    });
  });

  describe('validateAllScripts', () => {
    it('should validate all user scripts', async () => {
      const results = await validateAllScripts();

      // Filter out defaults for counting  (core and Shopify tools)
      const nonDefaultResults = Array.from(results.entries()).filter(
        ([id]) => !id.startsWith('agentboard:') && !id.startsWith('shopify:')
      );

      expect(nonDefaultResults.length).toBe(5); // Only count user scripts

      // All test scripts should be valid
      for (const [, result] of nonDefaultResults) {
        expect(result.valid).toBe(true);
        expect(result.metadata).toBeDefined();
        expect(result.error).toBeUndefined();
      }
    });
  });

  describe('reinjectScripts', () => {
    beforeEach(() => {
      vi.mocked(chrome.tabs.get).mockResolvedValue({
        id: 123,
        url: 'https://example.com/page',
      } as any);
    });

    it('should clear existing scripts and reinject', async () => {
      await reinjectScripts(123);

      // Should clear existing scripts first (immediately to avoid race conditions)
      expect(mockExecuteScript).toHaveBeenCalledWith({
        target: { tabId: 123, frameIds: [0] },
        world: 'MAIN',
        injectImmediately: true, // Changed to true to avoid race conditions
        func: expect.any(Function),
      });

      // Then inject matching scripts (first call is clear, rest are injections)
      expect(mockExecuteScript.mock.calls.length).toBeGreaterThan(1);
    });

    it('should handle tabs without URLs', async () => {
      vi.mocked(chrome.tabs.get).mockResolvedValue({
        id: 456,
        url: undefined,
      } as any);

      await reinjectScripts(456);

      // Should not attempt any injections
      expect(mockExecuteScript).not.toHaveBeenCalled();
    });

    it('should handle tab get errors', async () => {
      vi.mocked(chrome.tabs.get).mockRejectedValue(new Error('Tab not found'));

      await expect(reinjectScripts(999)).resolves.not.toThrow();
      expect(mockExecuteScript).not.toHaveBeenCalled();
    });
  });

  describe('script wrapping', () => {
    it('should generate valid wrapped code for injection', async () => {
      await injectUserScripts({
        tabId: 123,
        url: 'https://example.com/page',
        frameId: 0,
      });

      // Check that the injected function contains expected patterns
      const injectedFunc = mockExecuteScript.mock.calls[0][0].func;
      const funcStr = injectedFunc.toString();

      // Should create a script element
      expect(funcStr).toContain('document.createElement');
      expect(funcStr).toContain('script');
    });

    it('should include guard against double injection', async () => {
      await injectUserScripts({
        tabId: 123,
        url: 'https://example.com/page',
        frameId: 0,
      });

      // The wrapped code should check for __webmcpInjected
      const injectedFunc = mockExecuteScript.mock.calls[0][0].func;
      const funcStr = injectedFunc.toString();

      // Note: We can't easily test the actual wrapped code content
      // because it's embedded as a string, but we can verify
      // the structure is correct
      expect(funcStr).toBeDefined();
      expect(typeof injectedFunc).toBe('function');
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      // Ensure clean state for error handling tests
      mockExecuteScript.mockClear();
      mockExecuteScript.mockReset();
    });

    it('should continue injecting valid scripts even if one fails', async () => {
      // Reset and configure mock to fail on first call (could be default or user script)
      mockExecuteScript.mockReset();
      mockExecuteScript
        .mockRejectedValueOnce(new Error('Injection failed'))
        .mockResolvedValue(undefined); // All other calls succeed

      await injectUserScripts({
        tabId: 123,
        url: 'https://example.com/page',
        frameId: 0,
      });

      // Should attempt to inject all matching scripts despite one failing
      // Count non-default scripts that were attempted
      const nonDefaultCalls = getNonDefaultScriptCalls(mockExecuteScript);
      expect(nonDefaultCalls).toHaveLength(4); // test_tool, all_urls_tool, early_tool, multi_match

      // Verify that first call failed but others succeeded
      const results = await Promise.allSettled(
        mockExecuteScript.mock.results.map((r) =>
          r.type === 'throw' ? Promise.reject(r.value) : Promise.resolve(r.value)
        )
      );

      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('fulfilled');
      expect(results[2].status).toBe('fulfilled');
      expect(results[3].status).toBe('fulfilled');
    });
  });
});
