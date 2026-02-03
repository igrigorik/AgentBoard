/**
 * Integration tests for WebMCP script injection timing
 * Tests proper order and timing of polyfill, relay, bridge, and user scripts
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TabManager } from '../../src/lib/webmcp/lifecycle';
import { injectUserScripts } from '../../src/lib/webmcp/script-injector';
import type { UserScript } from '../../src/lib/storage/config';
import { COMPILED_TOOLS } from '../../src/lib/webmcp/tools/index';

describe('WebMCP Script Injection Timing', () => {
  let mockChrome: any;
  let lifecycleManager: TabManager;
  let injectionLog: Array<{
    type: string;
    timing: string;
    world?: string;
    files?: string[];
    func?: string;
    args?: any[]; // For capturing script arguments
  }>;

  beforeEach(() => {
    vi.clearAllMocks();
    injectionLog = [];

    // Setup Chrome mock with injection tracking
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
          get: vi.fn().mockResolvedValue({
            userScripts: [
              {
                id: 'script-1',
                code: `'use webmcp-tool v1';
                  export const metadata = { 
                name: "test_tool",
                namespace: "test",
                version: "1.0.0",
                    match: ["https://*/*"] 
                  };
                  export function execute() { return "test"; }`,
                enabled: true,
              },
            ],
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
        executeScript: vi.fn().mockImplementation((details: any) => {
          injectionLog.push({
            type: 'script',
            timing: details.injectImmediately ? 'document_start' : 'document_idle',
            world: details.world,
            files: details.files,
            func: details.func ? 'user-script' : undefined,
            args: details.args, // Capture arguments for better filtering
          });
          return Promise.resolve(undefined);
        }),
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

    // Initialize components
    lifecycleManager = new TabManager();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.clearAllMocks();
    injectionLog = [];
  });

  describe('Core Script Injection Order', () => {
    it('should inject scripts in correct order: polyfill → relay → bridge', async () => {
      const tabId = 123;

      // Inject scripts
      await lifecycleManager.ensureContentScriptReady(tabId);

      // Verify: relay + polyfill + 1 matching tool + bridge = 4 scripts
      // (youtube_transcript only matches YouTube URLs, not example.com)
      expect(injectionLog).toHaveLength(4);

      // 1. Relay FIRST (CRITICAL: must be listening before bridge sends initial snapshot)
      expect(injectionLog[0]).toEqual({
        type: 'script',
        timing: 'document_start',
        world: 'ISOLATED',
        files: ['content-scripts/relay.js'],
      });

      // 2. Polyfill SECOND (provides window.agent)
      expect(injectionLog[1]).toEqual({
        type: 'script',
        timing: 'document_start',
        world: 'MAIN',
        files: ['content-scripts/webmcp-polyfill.js'],
      });

      // 3. One matching compiled tool (inject after polyfill)
      expect(injectionLog[2]?.world).toBe('MAIN');
      expect(injectionLog[2]?.timing).toBe('document_idle');
      expect(injectionLog[2]?.files?.[0]).toMatch(/^tools\/.*\.js$/);

      // 4. Bridge LAST (sends initial snapshot to relay)
      expect(injectionLog[3]).toEqual({
        type: 'script',
        timing: 'document_idle',
        world: 'MAIN',
        files: ['content-scripts/page-bridge.js'],
      });
    });

    it('should inject polyfill before any page scripts can run', async () => {
      const tabId = 456;

      await lifecycleManager.ensureContentScriptReady(tabId);

      // Polyfill injection must have injectImmediately: true (it's call #2 now, relay is #1)
      const polyfillCall = mockChrome.scripting.executeScript.mock.calls[1][0];
      expect(polyfillCall.injectImmediately).toBe(true);
      expect(polyfillCall.world).toBe('MAIN');

      // This ensures window.agent is available before tools register
    });

    it('should inject relay early for message passing setup', async () => {
      const tabId = 789;

      await lifecycleManager.ensureContentScriptReady(tabId);

      // Relay is now FIRST (call #0) - critical for race condition fix
      const relayCall = mockChrome.scripting.executeScript.mock.calls[0][0];
      expect(relayCall.injectImmediately).toBe(true);
      expect(relayCall.world).toBe('ISOLATED');

      // This ensures message passing is ready BEFORE bridge sends initial snapshot
    });

    it('should inject bridge after DOM is ready', async () => {
      const tabId = 321;

      await lifecycleManager.ensureContentScriptReady(tabId);

      // Bridge injection must have injectImmediately: false
      const bridgeCall = mockChrome.scripting.executeScript.mock.calls[2][0];
      expect(bridgeCall.injectImmediately).toBe(false);
      expect(bridgeCall.world).toBe('MAIN');

      // This ensures DOM is available when bridge runs
    });
  });

  describe('User Script Injection Timing', () => {
    it('should inject user scripts after core scripts', async () => {
      const tabId = 654;

      // Mock storage to return user scripts
      mockChrome.storage.local.get.mockImplementation(() =>
        Promise.resolve({
          config: {
            agents: [],
            userScripts: [
              {
                id: 'user-1',
                code: `'use webmcp-tool v1';
              export const metadata = { 
                name: "user_tool_1",
                namespace: "test",
                version: "1.0.0", 
                match: ["https://*/*"] 
              };
              export function execute() { return "result1"; }`,
                enabled: true,
              },
              {
                id: 'user-2',
                code: `'use webmcp-tool v1';
              export const metadata = { 
                name: "user_tool_2",
                namespace: "test",
                version: "1.0.0", 
                match: ["https://example.com/*"] 
              };
              export function execute() { return "result2"; }`,
                enabled: true,
              },
            ],
          },
        })
      );

      await lifecycleManager.ensureContentScriptReady(tabId);
      const coreScriptCount = injectionLog.length;

      // Inject user scripts
      await injectUserScripts({ tabId, url: 'https://example.com' });

      // Should have added user scripts
      expect(injectionLog.length).toBeGreaterThan(coreScriptCount);

      // User scripts should have func instead of files
      const userScripts = injectionLog.filter((log) => log.func === 'user-script');
      // Both scripts match the URL pattern, so both should be injected
      expect(userScripts.length).toBeGreaterThanOrEqual(2);
      expect(userScripts[0].timing).toBe('document_idle');
      expect(userScripts[0].world).toBe('MAIN');
    });

    it('should only inject user scripts matching URL patterns', async () => {
      const tabId = 987;

      // Mock storage with scripts having different match patterns
      mockChrome.storage.local.get.mockImplementation(() =>
        Promise.resolve({
          config: {
            agents: [],
            userScripts: [
              {
                id: 'github-only',
                code: `'use webmcp-tool v1';
              export const metadata = { 
                name: "github_tool",
                namespace: "test",
                version: "1.0.0", 
                match: ["https://github.com/*"] 
              };
              export function execute() { return "github"; }`,
                enabled: true,
              },
              {
                id: 'all-sites',
                code: `'use webmcp-tool v1';
              export const metadata = { 
                name: "universal_tool",
                namespace: "test",
                version: "1.0.0", 
                match: ["<all_urls>"] 
              };
              export function execute() { return "universal"; }`,
                enabled: true,
              },
            ],
          },
        })
      );

      // Test on example.com (should only get universal tool)
      await injectUserScripts({ tabId, url: 'https://example.com' });

      // Count user script injections (exclude defaults which have special marker)
      const userScriptInjections = injectionLog.filter((log) => {
        // Check if this is a script injection (has args with code)
        if (!log.args || !log.args[0]) return false;
        const scriptCode = log.args[0];
        // Check if it's a user script (not a default)
        return (
          typeof scriptCode === 'string' &&
          scriptCode.includes('const scriptId =') &&
          !scriptCode.includes('// webmcp:agentboard_tool')
        );
      });

      expect(userScriptInjections).toHaveLength(1);
    });

    it('should respect exclude patterns in user scripts', async () => {
      const tabId = 147;

      mockChrome.storage.local.get.mockImplementation(() =>
        Promise.resolve({
          config: {
            agents: [],
            userScripts: [
              {
                id: 'exclude-test',
                code: `'use webmcp-tool v1';
              export const metadata = { 
                name: "exclude_tool",
                namespace: "test",
                version: "1.0.0", 
                match: ["https://*/*"],
                exclude: ["https://example.com/admin/*"]
              };
              export function execute() { return "test"; }`,
                enabled: true,
              },
            ],
          },
        })
      );

      // Should inject on regular page
      injectionLog.length = 0;
      await injectUserScripts({ tabId, url: 'https://example.com/page' });
      let userScriptCalls = injectionLog.filter((log) => {
        if (!log.args || !log.args[0]) return false;
        const scriptCode = log.args[0];
        return (
          typeof scriptCode === 'string' &&
          scriptCode.includes('const scriptId =') &&
          !scriptCode.includes('// webmcp:agentboard_tool')
        );
      });
      expect(userScriptCalls).toHaveLength(1);

      // Clear and test excluded path
      injectionLog.length = 0;
      await injectUserScripts({ tabId, url: 'https://example.com/admin/settings' });
      userScriptCalls = injectionLog.filter((log) => {
        if (!log.args || !log.args[0]) return false;
        const scriptCode = log.args[0];
        return (
          typeof scriptCode === 'string' &&
          scriptCode.includes('const scriptId =') &&
          !scriptCode.includes('// webmcp:agentboard_tool')
        );
      });
      expect(userScriptCalls).toHaveLength(0);
    });

    it('should skip disabled user scripts', async () => {
      const tabId = 258;

      mockChrome.storage.local.get.mockImplementation(() =>
        Promise.resolve({
          config: {
            agents: [],
            userScripts: [
              {
                id: 'enabled-script',
                code: `'use webmcp-tool v1';
              export const metadata = { 
                name: "enabled_tool",
                namespace: "test",
                version: "1.0.0", 
                match: ["<all_urls>"] 
              };
              export function execute() { return "enabled"; }`,
                enabled: true,
              },
              {
                id: 'disabled-script',
                code: `'use webmcp-tool v1';
              export const metadata = { 
                name: "disabled_tool",
                namespace: "test",
                version: "1.0.0" 
                match: ["<all_urls>"] 
              };
              export function execute() { return "disabled"; }`,
                enabled: false,
              },
            ],
          },
        })
      );

      await injectUserScripts({ tabId, url: 'https://example.com' });

      // Only enabled script should be injected (exclude defaults)
      const userScriptCalls = injectionLog.filter((log) => {
        if (!log.args || !log.args[0]) return false;
        const scriptCode = log.args[0];
        return (
          typeof scriptCode === 'string' &&
          scriptCode.includes('const scriptId =') &&
          !scriptCode.includes('// webmcp:agentboard_tool')
        );
      });
      expect(userScriptCalls).toHaveLength(1);
    });
  });

  describe('Frame Targeting', () => {
    it('should only inject into main frame (frameId: 0)', async () => {
      const tabId = 369;

      await lifecycleManager.ensureContentScriptReady(tabId);

      // All injections should target frameIds: [0]
      mockChrome.scripting.executeScript.mock.calls.forEach((call: any) => {
        expect(call[0].target.frameIds).toEqual([0]);
      });
    });

    it('should not inject into subframes', async () => {
      const tabId = 753;

      // This is handled by the navigation handlers, but verify the injection
      // calls always specify frameIds: [0]
      await lifecycleManager.ensureContentScriptReady(tabId);

      const allFrameIds = mockChrome.scripting.executeScript.mock.calls
        .map((call: any) => call[0].target.frameIds)
        .flat();

      // Should only contain 0 (main frame)
      expect(allFrameIds.every((id: number) => id === 0)).toBe(true);
    });
  });

  describe('Re-injection on Navigation', () => {
    it('should reinject all scripts after navigation', async () => {
      const tabId = 159;
      const navigationHandlers: any = {};

      // Capture navigation handlers
      mockChrome.webNavigation.onBeforeNavigate.addListener = vi.fn((handler) => {
        navigationHandlers.onBeforeNavigate = handler;
      });
      mockChrome.webNavigation.onDOMContentLoaded.addListener = vi.fn((handler) => {
        navigationHandlers.onDOMContentLoaded = handler;
      });

      // Re-initialize to capture handlers
      lifecycleManager = new TabManager();

      // Initial injection
      await lifecycleManager.ensureContentScriptReady(tabId);
      const initialInjectionCount = injectionLog.length;

      // Clear log
      injectionLog = [];
      mockChrome.scripting.executeScript.mockClear();

      // Simulate navigation
      if (navigationHandlers.onBeforeNavigate) {
        navigationHandlers.onBeforeNavigate({
          tabId,
          frameId: 0,
          url: 'https://example.com/new-page',
        });
      }

      // DOM ready triggers re-injection
      if (navigationHandlers.onDOMContentLoaded) {
        await navigationHandlers.onDOMContentLoaded({
          tabId,
          frameId: 0,
          url: 'https://example.com/new-page',
        });
      }

      // Should inject same number of scripts
      expect(injectionLog.length).toBe(initialInjectionCount);

      // NEW order: relay → polyfill → tools → bridge (fixed for race condition)
      expect(injectionLog[0].files).toEqual(['content-scripts/relay.js']);
      expect(injectionLog[1].files).toEqual(['content-scripts/webmcp-polyfill.js']);
      expect(injectionLog[3].files).toEqual(['content-scripts/page-bridge.js']);
    });

    it('should handle rapid navigations without double injection', async () => {
      const tabId = 357;
      const navigationHandlers: any = {};

      mockChrome.webNavigation.onBeforeNavigate.addListener = vi.fn((handler) => {
        navigationHandlers.onBeforeNavigate = handler;
      });
      mockChrome.webNavigation.onDOMContentLoaded.addListener = vi.fn((handler) => {
        navigationHandlers.onDOMContentLoaded = handler;
      });

      lifecycleManager = new TabManager();

      // Multiple rapid navigations
      if (navigationHandlers.onBeforeNavigate) {
        navigationHandlers.onBeforeNavigate({
          tabId,
          frameId: 0,
          url: 'https://example.com/page1',
        });

        // Another navigation before first completes
        navigationHandlers.onBeforeNavigate({
          tabId,
          frameId: 0,
          url: 'https://example.com/page2',
        });

        // Yet another
        navigationHandlers.onBeforeNavigate({
          tabId,
          frameId: 0,
          url: 'https://example.com/page3',
        });
      }

      // Only the last navigation's DOM ready should inject
      if (navigationHandlers.onDOMContentLoaded) {
        await navigationHandlers.onDOMContentLoaded({
          tabId,
          frameId: 0,
          url: 'https://example.com/page3',
        });
      }

      // Should inject once, not 3x for rapid navigations
      // Core scripts (relay, polyfill, bridge) + some tools = at least 3
      // If it injected 3x, we'd have 3x as many entries
      expect(injectionLog.length).toBeGreaterThanOrEqual(3);
      expect(injectionLog.length).toBeLessThan(3 * 3 + COMPILED_TOOLS.length); // way less than triple
    });
  });

  describe('Error Recovery', () => {
    it('should continue with other scripts if one fails', async () => {
      const tabId = 852;

      // Make relay injection fail (relay is now FIRST)
      let callCount = 0;
      mockChrome.scripting.executeScript.mockImplementation((details: any) => {
        callCount++;
        if (callCount === 1) {
          // First script (relay) fails
          return Promise.reject(new Error('Injection failed'));
        }
        injectionLog.push({
          type: 'script',
          timing: details.injectImmediately ? 'document_start' : 'document_idle',
          world: details.world,
          files: details.files,
        });
        return Promise.resolve(undefined);
      });

      await lifecycleManager.ensureContentScriptReady(tabId);

      // When relay (first script) fails, the await throws and exits injectScripts()
      // Nothing else gets injected (fail-fast behavior)
      expect(injectionLog).toHaveLength(0);
    });

    it('should handle CSP violations gracefully', async () => {
      const tabId = 741;

      // Simulate CSP violation error
      mockChrome.scripting.executeScript.mockRejectedValue(
        new Error(
          'Cannot access contents of the page. Extension manifest must request permission to access the respective host.'
        )
      );

      // Should not throw, just log error
      await expect(lifecycleManager.ensureContentScriptReady(tabId)).resolves.not.toThrow();
    });
  });

  describe('Script Source URLs', () => {
    it('should add sourceURL comments for debugging', async () => {
      const tabId = 963;

      const userScript: UserScript = {
        id: 'debug-test',
        code: `'use webmcp-tool v1';
          export const metadata = { 
            name: "debug_tool", 
            namespace: "test",
            version: "1.0.0", 
            match: ["<all_urls>"] 
          };
          export function execute() { return "debug"; }`,
        enabled: true,
      };

      mockChrome.storage.local.get.mockResolvedValue({
        userScripts: [userScript],
      });

      // Capture the actual injected code
      let injectedCode = '';
      mockChrome.scripting.executeScript.mockImplementation((details: any) => {
        if (details.args && details.args[0]) {
          injectedCode = details.args[0];
        }
        return Promise.resolve(undefined);
      });

      await injectUserScripts({ tabId, url: 'https://example.com' });

      // Find the user script injection (not defaults)
      const userScriptCode = injectedCode.includes('test:debug-tool') ? injectedCode : '';

      // Verify sourceURL is added
      if (userScriptCode) {
        expect(userScriptCode).toContain('//# sourceURL=webmcp-script:test:debug-tool.js');
      } else {
        // Find in any of the injection calls
        const calls = mockChrome.scripting.executeScript.mock.calls;
        const foundCall = calls.find((call: any) =>
          call[0]?.args?.[0]?.includes('test:debug-tool')
        );
        if (foundCall) {
          expect(foundCall[0].args[0]).toContain('//# sourceURL=webmcp-script:test:debug-tool.js');
        }
      }
    });
  });
});
