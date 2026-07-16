/**
 * Unit tests for WebMCP script injector
 */

import { readFileSync } from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import path from 'path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  injectUserScripts,
  getMatchingScripts,
  validateAllScripts,
  reinjectScripts,
} from '../src/lib/webmcp/script-injector';

const polyfillSource = readFileSync(
  path.join(__dirname, '../src/content-scripts/webmcp-polyfill.js'),
  'utf8'
);

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

export function shouldRegister({ signal } = {}) {
  window.__testRegistrationSignal = signal;
  return true;
}

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

      // Lifecycle owns built-in tools, so these are the four matching user scripts.
      expect(mockExecuteScript.mock.calls.length).toBe(4); // test_tool, all_urls_tool, early_tool, multi_match

      // Check that scripts are injected with correct world and frame
      expect(mockExecuteScript).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { tabId: 123, frameIds: [0] },
          world: 'MAIN',
        })
      );
    });

    it('should register generated tools through document.modelContext', async () => {
      await injectUserScripts({
        tabId: 123,
        url: 'https://example.com/page',
        frameId: 0,
      });

      const wrappedCode = mockExecuteScript.mock.calls[0][0].args[0];
      expect(wrappedCode).toContain('document.modelContext');
      expect(wrappedCode).toContain('modelContext.registerTool(tool, {');
      expect(wrappedCode).toContain('signal: registrationController.signal');
      expect(wrappedCode).not.toContain('window.agent');
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
      expect(mockExecuteScript.mock.calls).toHaveLength(4); // Only enabled user scripts
      expect(wasScriptInjected(mockExecuteScript, 'disabled_tool')).toBe(false);
    });

    it('should not inject scripts that do not match URL', async () => {
      await injectUserScripts({
        tabId: 456,
        url: 'https://other.com/page',
        frameId: 0,
      });

      // Only all_urls_tool should be injected from user scripts
      expect(mockExecuteScript.mock.calls).toHaveLength(1);
      // Public names combine the script namespace and local tool name.
      expect(wasScriptInjected(mockExecuteScript, 'all_urls_tool')).toBe(true);
    });

    it('should exclude URLs based on exclude patterns', async () => {
      await injectUserScripts({
        tabId: 789,
        url: 'http://localhost/page',
        frameId: 0,
      });

      // all_urls_tool excludes localhost.
      expect(mockExecuteScript.mock.calls).toHaveLength(0); // No user scripts should inject
      expect(wasScriptInjected(mockExecuteScript, 'all_urls_tool')).toBe(false);
    });

    it('should handle multiple match patterns', async () => {
      await injectUserScripts({
        tabId: 111,
        url: 'https://test.com/api',
        frameId: 0,
      });

      // Lifecycle owns built-in tools, so only matching user scripts appear here.
      expect(mockExecuteScript.mock.calls.length).toBe(2); // multi_match and all_urls_tool
    });
  });

  describe('getMatchingScripts', () => {
    it('should return all matching enabled scripts for a URL', async () => {
      const matching = await getMatchingScripts('https://example.com/page');

      expect(matching).toHaveLength(4);
      expect(matching.map((s) => s.id)).toContain('script1');
      expect(matching.map((s) => s.id)).toContain('script2'); // all_urls_tool
      expect(matching.map((s) => s.id)).toContain('script4');
      expect(matching.map((s) => s.id)).toContain('script5');
    });

    it('should not include disabled scripts', async () => {
      const matching = await getMatchingScripts('https://any.com/page');

      // Should only include all_urls_tool, not disabled_tool.
      expect(matching).toHaveLength(1);
      expect(matching[0].id).toBe('script2');
    });

    it('should respect exclude patterns', async () => {
      const matching = await getMatchingScripts('http://localhost/test');

      // all_urls_tool excludes localhost.
      expect(matching).toHaveLength(0);
    });
  });

  describe('validateAllScripts', () => {
    it('should validate all user scripts', async () => {
      const results = await validateAllScripts();

      expect(results.size).toBe(5);

      // All test scripts should be valid.
      for (const [, result] of results) {
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

    it('should clear existing registrations, then rebuild built-in and user tools', async () => {
      const injectBuiltInTools = vi.fn(async () => {
        await mockExecuteScript({ files: ['tools/builtin.js'] });
      });
      await reinjectScripts(123, injectBuiltInTools);

      // Should clear existing scripts first (immediately to avoid race conditions)
      expect(mockExecuteScript).toHaveBeenCalledWith({
        target: { tabId: 123, frameIds: [0] },
        world: 'MAIN',
        injectImmediately: true, // Cleanup must complete before replacement injection.
        func: expect.any(Function),
        args: [expect.any(String)],
      });

      expect(injectBuiltInTools).toHaveBeenCalledWith('https://example.com/page');
      expect(mockExecuteScript.mock.calls[1][0]).toEqual({ files: ['tools/builtin.js'] });
      expect(mockExecuteScript.mock.calls[2][0].args[0]).toContain('test_test_tool');
    });

    it('should remove old registrations before reinjection', async () => {
      await injectUserScripts({
        tabId: 123,
        url: 'https://example.com/page',
        frameId: 0,
      });
      const initialCode = mockExecuteScript.mock.calls[0][0].args[0];

      const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://example.com/page',
        runScripts: 'dangerously',
        virtualConsole: new VirtualConsole(),
      });
      dom.window.eval(polyfillSource);
      dom.window.eval(initialCode);
      await Promise.resolve();

      const modelContext = (dom.window.document as any).modelContext;
      const initialSignal = (dom.window as any).__testRegistrationSignal;
      expect(initialSignal).toBeInstanceOf(dom.window.AbortSignal);
      expect(initialSignal.aborted).toBe(false);
      let tools = await modelContext.getTools();
      const initialTool = tools.find((tool: any) => tool.name === 'test_test_tool');
      expect(await modelContext.executeTool(initialTool, '{}')).toBe('test result');

      mockExecuteScript.mockClear();
      vi.mocked(chrome.tabs.get).mockResolvedValue({
        id: 123,
        url: 'https://example.com/page',
      } as any);
      await reinjectScripts(123);

      const builtInController = new dom.window.AbortController();
      (dom.window as any).__agentboardBuiltinToolLifetimes = new (dom.window as any).Map([
        ['builtin_tool', builtInController],
      ]);
      const cleanup = mockExecuteScript.mock.calls[0][0].func;
      const cleanupGeneration = mockExecuteScript.mock.calls[0][0].args[0];
      dom.window.eval(`(${cleanup.toString()})(${JSON.stringify(cleanupGeneration)})`);
      expect((dom.window as any).__agentboardUserScriptGeneration).toBe(cleanupGeneration);
      expect(initialSignal.aborted).toBe(true);
      expect(builtInController.signal.aborted).toBe(true);
      expect(await modelContext.getTools()).toEqual([]);

      const updatedCode = mockExecuteScript.mock.calls[1][0].args[0].replace(
        'return "test result";',
        'return "updated result";'
      );
      dom.window.eval(updatedCode);
      await Promise.resolve();

      tools = await modelContext.getTools();
      const updatedTool = tools.find((tool: any) => tool.name === 'test_test_tool');
      expect(tools).toHaveLength(1);
      expect(await modelContext.executeTool(updatedTool, '{}')).toBe('updated result');
      dom.window.close();
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

      // The injector waits for the blob load and stale generations self-suppress.
      expect(funcStr).toContain('new Promise');
      expect(funcStr).toContain('__agentboardUserScriptGeneration');
      expect(funcStr).toContain('document.createElement');
      expect(funcStr).toContain('script');
    });

    it('should suppress an older blob that loads after a newer script generation', async () => {
      await injectUserScripts({
        tabId: 123,
        url: 'https://example.com/page',
        frameId: 0,
      });
      const injectionFunc = mockExecuteScript.mock.calls[0][0].func;
      const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
        url: 'https://example.com/page',
        runScripts: 'dangerously',
        virtualConsole: new VirtualConsole(),
      });
      const sources = new Map<string, string>();
      const queuedScripts: HTMLScriptElement[] = [];
      let nextBlobId = 0;
      class TestBlob {
        source: string;
        constructor(parts: unknown[]) {
          this.source = parts.join('');
        }
      }
      Object.defineProperty(dom.window, 'Blob', { value: TestBlob });
      Object.defineProperty(dom.window.URL, 'createObjectURL', {
        value(blob: TestBlob) {
          const url = `blob:test-${nextBlobId++}`;
          sources.set(url, blob.source);
          return url;
        },
      });
      Object.defineProperty(dom.window.URL, 'revokeObjectURL', { value: vi.fn() });
      vi.spyOn(dom.window.document.head, 'appendChild').mockImplementation((node: Node) => {
        queuedScripts.push(node as HTMLScriptElement);
        return node;
      });
      const injectInPage = dom.window.eval(`(${injectionFunc.toString()})`) as (
        code: string,
        generation: string
      ) => Promise<void>;

      const oldLoad = injectInPage(`window.__raceWinner = 'old';`, 'old-generation');
      (dom.window as any).__agentboardUserScriptGeneration = 'new-generation';
      const newLoad = injectInPage(`window.__raceWinner = 'new';`, 'new-generation');
      expect(queuedScripts).toHaveLength(2);

      for (const script of queuedScripts) {
        dom.window.eval(sources.get(script.src)!);
        script.dispatchEvent(new dom.window.Event('load'));
      }
      await Promise.all([oldLoad, newLoad]);

      expect((dom.window as any).__raceWinner).toBe('new');
      (dom.window as any).__agentboardUserScriptGeneration = 'latest-generation';
      await injectInPage(`window.__raceWinner = 'stale';`, 'stale-generation');
      expect(queuedScripts).toHaveLength(2);
      expect((dom.window as any).__raceWinner).toBe('new');
      dom.window.close();
    });

    it('should revoke the blob URL when DOM insertion fails', async () => {
      await injectUserScripts({
        tabId: 123,
        url: 'https://example.com/page',
        frameId: 0,
      });
      const injectionFunc = mockExecuteScript.mock.calls[0][0].func;
      const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
        url: 'https://example.com/page',
        runScripts: 'dangerously',
        virtualConsole: new VirtualConsole(),
      });
      const blobUrl = 'blob:append-failure';
      Object.defineProperty(dom.window.URL, 'createObjectURL', {
        value: vi.fn(() => blobUrl),
      });
      const revokeObjectURL = vi.fn(() => {
        throw new Error('hostile revokeObjectURL');
      });
      Object.defineProperty(dom.window.URL, 'revokeObjectURL', { value: revokeObjectURL });
      vi.spyOn(dom.window.document.head, 'appendChild').mockImplementation(() => {
        throw new Error('append failed');
      });
      const injectInPage = dom.window.eval(`(${injectionFunc.toString()})`) as (
        code: string,
        generation: string
      ) => Promise<void>;

      await expect(injectInPage('window.__neverRuns = true;', 'generation')).rejects.toThrow(
        'append failed'
      );
      expect(revokeObjectURL).toHaveBeenCalledWith(blobUrl);
      expect(dom.window.document.querySelector('script')).toBeNull();
      dom.window.close();
    });

    it('should include guard against double injection', async () => {
      await injectUserScripts({
        tabId: 123,
        url: 'https://example.com/page',
        frameId: 0,
      });

      const wrappedCode = mockExecuteScript.mock.calls[0][0].args[0];
      expect(wrappedCode).toContain('window.__webmcpInjected[scriptId]');
      expect(wrappedCode).toContain('window.__webmcpInjected[scriptId] = true');
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

      // Every matching user script is attempted despite the first failure.
      expect(mockExecuteScript.mock.calls).toHaveLength(4);

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
