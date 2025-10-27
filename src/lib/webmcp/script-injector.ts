/**
 * WebMCP User Script Injector
 * Handles dynamic injection of user-provided scripts into the MAIN world.
 */

import log from '../logger';
import { ConfigStorage, type UserScript, type UserScriptMetadata } from '../storage/config';
import { parseUserScript, matchesUrl, ScriptParsingError } from './script-parser';

// Type declarations for Trusted Types policy created in webmcp-polyfill.js
// TrustedScriptURL is the return type from createScriptURL()
type TrustedScriptURL = string & { __brand: 'TrustedScriptURL' };

declare global {
  interface Window {
    __agentboardTTPolicy?: {
      createScriptURL: (url: string) => string | TrustedScriptURL;
    };
  }
}

const configStorage = ConfigStorage.getInstance();

export interface InjectionOptions {
  tabId: number;
  url: string;
  frameId?: number;
}

/**
 * Wraps a user script module for execution in MAIN world
 * Converts ES module exports to window.agent.registerTool() calls
 * All transformations happen here in the background worker,
 * not at runtime in the page.
 */
function wrapScriptForInjection(code: string, metadata: UserScriptMetadata): string {
  // Generate a unique script name for debugging (namespace is now required)
  const scriptName = `${metadata.namespace}:${metadata.name}`;
  const toolName = `${metadata.namespace}_${metadata.name}`;

  const transformedCode = code
    .replace(/^[\s\n]*'use webmcp-tool v\d+';[\s\n]*/m, '') // Remove pragma
    .replace(/export\s+const\s+metadata\s*=/g, 'const metadata =')
    .replace(/export\s+(async\s+)?function\s+execute/g, '$1function execute')
    .replace(/export\s+function\s+shouldRegister/g, 'function shouldRegister');

  // Wrap the PRE-TRANSFORMED code for direct execution (no eval/Function needed)
  return `
(function() {
  'use strict';
  // Guard against double injection
  const scriptId = '${scriptName.replace(/'/g, "\\'")}';
  if (window.__webmcpInjected && window.__webmcpInjected[scriptId]) {
    console.log('[WebMCP] Script already injected:', scriptId);
    return;
  }

  // Mark as injected
  window.__webmcpInjected = window.__webmcpInjected || {};
  window.__webmcpInjected[scriptId] = true;

  console.log('[WebMCP] Executing user script: ${scriptName}');

  try {
    ${transformedCode}

    console.log('[WebMCP] User script executed, checking exports:', {
      hasMetadata: typeof metadata !== 'undefined',
      hasExecute: typeof execute !== 'undefined',
      hasShouldRegister: typeof shouldRegister !== 'undefined'
    });

    if (typeof shouldRegister === 'function') {
      try {
        if (!shouldRegister()) {
          console.log('[WebMCP] Tool ${scriptName} skipped registration (shouldRegister returned false)');
          return;
        }
      } catch (error) {
        console.error('[WebMCP] Error in shouldRegister for ${scriptName}:', error);
        // Continue with registration if shouldRegister throws (fail-open)
      }
    }

    if (window.agent && typeof metadata !== 'undefined' && typeof execute !== 'undefined') {
      const tool = {
        name: '${toolName}',
        description: metadata.description || '${metadata.description || ''}',
        inputSchema: metadata.inputSchema || { type: 'object', properties: {} },
        execute: execute
      };

      window.agent.registerTool(tool);
      console.log('[WebMCP] Registered tool ${toolName} v${metadata.version}');
    } else {
      console.error('[WebMCP] Failed to register ${scriptName}:', {
        hasAgent: !!window.agent,
        hasMetadata: typeof metadata !== 'undefined',
        hasExecute: typeof execute !== 'undefined'
      });
    }

  } catch (error) {
    console.error('[WebMCP] Error executing script ${scriptName}:', error);
  }
})();
//# sourceURL=webmcp-script:${scriptName}.js`;
}

/**
 * Get all user scripts for injection
 * Built-in tools are now handled by lifecycle.ts via pre-compiled files
 */
export async function getAllScriptsForInjection(): Promise<UserScript[]> {
  // Only return user-provided scripts
  const storedScripts = await configStorage.getUserScripts();
  return storedScripts;
}

/**
 * Inject user scripts into a tab that match the URL
 */
export async function injectUserScripts(options: InjectionOptions): Promise<void> {
  const { tabId, url, frameId = 0 } = options;

  try {
    // Get all scripts (defaults + user scripts)
    const allScripts = await getAllScriptsForInjection();
    const enabledScripts = allScripts.filter((s) => s.enabled);

    log.debug(`[WebMCP Injector] Processing ${enabledScripts.length} enabled scripts for ${url}`);

    for (const script of enabledScripts) {
      try {
        await injectSingleScript(script, tabId, url, frameId);
      } catch (error) {
        log.error(`[WebMCP Injector] Failed to inject script ${script.id}:`, error);
      }
    }
  } catch (error) {
    log.error('[WebMCP Injector] Failed to get user scripts:', error);
  }
}

/**
 * Inject a single user script if it matches the URL
 */
async function injectSingleScript(
  script: UserScript,
  tabId: number,
  url: string,
  frameId: number
): Promise<void> {
  try {
    // Parse and validate the script (all scripts here are user scripts)
    const { metadata, code } = parseUserScript(script.code, true);

    // Check if script matches the URL
    if (!matchesUrl(url, metadata)) {
      log.debug(`[WebMCP Injector] Script ${metadata.name} doesn't match URL ${url}`);
      return;
    }

    log.info(
      `[WebMCP Injector] Injecting script ${metadata.name} v${metadata.version} into tab ${tabId}`
    );

    // Wrap the code for MAIN world execution
    const wrappedCode = wrapScriptForInjection(code, metadata);

    // Always inject at document_idle for consistent behavior
    const injectImmediately = false;

    const injectionFunc = (codeToInject: string) => {
      console.warn('[WebMCP] Creating blob URL for user script injection');

      try {
        // Create a Blob with the script code
        const blob = new Blob([codeToInject], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);

        console.warn('[WebMCP] Blob URL created:', blobUrl);

        // Load script from blob: URL (external source, not inline)
        const script = document.createElement('script');

        // Try to set src - may need Trusted Types policy on strict sites
        try {
          // Use TT policy if available (created by webmcp-polyfill.js)
          if (window.__agentboardTTPolicy) {
            console.warn('[WebMCP] Using Trusted Types policy for user script');
            script.src = window.__agentboardTTPolicy.createScriptURL(blobUrl);
          } else {
            script.src = blobUrl;
          }
        } catch (trustedTypesError) {
          console.error('[WebMCP] ❌ Trusted Types blocked user script injection');
          console.error('[WebMCP] This site requires TrustedScriptURL but policy creation failed');
          console.error('[WebMCP] Possible reasons:');
          console.error('[WebMCP]   1. CSP restricts policy names (trusted-types directive)');
          console.error('[WebMCP]   2. Site blocks all dynamic policy creation');
          console.error('[WebMCP] Technical details:', trustedTypesError);

          URL.revokeObjectURL(blobUrl);
          return;
        }

        script.onload = () => {
          console.warn('[WebMCP] ✅ User script loaded successfully via blob URL');
          URL.revokeObjectURL(blobUrl);
        };
        script.onerror = (e) => {
          console.error('[WebMCP] ❌ Failed to load script from blob URL:', e);
          URL.revokeObjectURL(blobUrl);
        };

        (document.head || document.documentElement).appendChild(script);
      } catch (error) {
        console.error('[WebMCP] ❌ Unexpected error during blob injection:', error);
      }
    };

    // Inject the script
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      injectImmediately,
      func: injectionFunc,
      args: [wrappedCode],
    });

    log.info(`[WebMCP Injector] Successfully injected ${metadata.name}`);
  } catch (error) {
    if (error instanceof ScriptParsingError) {
      log.error(`[WebMCP Injector] Invalid script format:`, error.message);
    } else {
      throw error;
    }
  }
}

/**
 * Get all user scripts that match a URL
 */
export async function getMatchingScripts(url: string): Promise<UserScript[]> {
  const scripts = await getAllScriptsForInjection();
  const matching: UserScript[] = [];

  for (const script of scripts) {
    if (!script.enabled) continue;

    try {
      const { metadata } = parseUserScript(script.code, true);
      if (matchesUrl(url, metadata)) {
        matching.push(script);
      }
    } catch (error) {
      log.debug(`[WebMCP Injector] Skipping invalid script ${script.id}:`, error);
    }
  }

  return matching;
}

/**
 * Validate all user scripts and return validation results
 */
export async function validateAllScripts(): Promise<
  Map<
    string,
    {
      valid: boolean;
      metadata?: UserScriptMetadata;
      error?: string;
    }
  >
> {
  const scripts = await getAllScriptsForInjection();
  const results = new Map<
    string,
    {
      valid: boolean;
      metadata?: UserScriptMetadata;
      error?: string;
    }
  >();

  for (const script of scripts) {
    try {
      const { metadata } = parseUserScript(script.code, true);
      results.set(script.id, { valid: true, metadata });
    } catch (error) {
      results.set(script.id, {
        valid: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return results;
}

/**
 * Re-inject scripts into a tab (useful after script updates)
 */
export async function reinjectScripts(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) {
      log.debug(`[WebMCP Injector] Tab ${tabId} has no URL`);
      return;
    }

    // First, clear the injection markers IMMEDIATELY to avoid race conditions
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      injectImmediately: true, // MUST run immediately before re-injection!
      func: () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((window as any).__webmcpInjected) {
          // eslint-disable-next-line no-console
          console.log('[WebMCP] Clearing injected scripts for re-injection');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__webmcpInjected = {};
        }
      },
    });

    // Re-inject matching scripts
    await injectUserScripts({
      tabId,
      url: tab.url,
      frameId: 0,
    });
  } catch (error) {
    log.error(`[WebMCP Injector] Failed to re-inject scripts:`, error);
  }
}
