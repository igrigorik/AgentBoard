/**
 * WebMCP User Script Injector
 * Handles dynamic injection of user-provided scripts into the MAIN world.
 */

import log from '../logger';
import { ConfigStorage, type UserScript, type UserScriptMetadata } from '../storage/config';
import { parseUserScript, matchesUrl, ScriptParsingError } from './script-parser';

const configStorage = ConfigStorage.getInstance();

export interface InjectionOptions {
  tabId: number;
  url: string;
  frameId?: number;
}

/**
 * Wraps a user script module for execution in MAIN world
 * Converts ES module exports to window.agent.registerTool() calls
 */
function wrapScriptForInjection(code: string, metadata: UserScriptMetadata): string {
  // Generate a unique script name for debugging (namespace is now required)
  const scriptName = `${metadata.namespace}:${metadata.name}`;

  // Wrap module code to execute in MAIN world
  // Converts ES module exports to tool registration
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
  
  // Execute module code with export interception
  try {
    // Transform the module code to work in a non-module context
    const transformedCode = ${JSON.stringify(code)}
      .replace(/^\\s*'use webmcp-tool v\\d+';\\s*/, '') // Remove pragma
      .replace(/export\\s+const\\s+metadata\\s*=/g, 'const metadata =')
      .replace(/export\\s+(async\\s+)?function\\s+execute/g, '$1function execute')
      .replace(/export\\s+function\\s+shouldRegister/g, 'function shouldRegister');
    
    // Use Function constructor instead of eval for better security
    const moduleFunc = new Function('exports', transformedCode + '; return { metadata, execute, shouldRegister: typeof shouldRegister !== "undefined" ? shouldRegister : undefined };');
    const moduleExports = moduleFunc({});
    
    // Check if tool should be registered (optional export)
    if (moduleExports.shouldRegister) {
      try {
        const shouldReg = moduleExports.shouldRegister();
        if (!shouldReg) {
          console.log('[WebMCP] Tool ${scriptName} skipped registration (shouldRegister returned false)');
          return;
        }
      } catch (error) {
        log.error('[WebMCP] Error in shouldRegister for ${scriptName}:', error);
        // Continue with registration if shouldRegister throws (fail-open)
      }
    }
    
    // Register tool with window.agent using namespace_name format
    if (window.agent && moduleExports.metadata && moduleExports.execute) {
      const toolName = moduleExports.metadata.namespace + '_' + moduleExports.metadata.name;
      const tool = {
        name: toolName,
        description: moduleExports.metadata.description || '${metadata.description || ''}',
        inputSchema: moduleExports.metadata.inputSchema,
        execute: moduleExports.execute
      };
      
      window.agent.registerTool(tool);
      console.log('[WebMCP] Registered tool ' + toolName + ' v${metadata.version}');
    } else {
      log.error('[WebMCP] Failed to register tool ${scriptName}:', {
        hasAgent: !!window.agent,
        hasMetadata: !!moduleExports.metadata,
        hasExecute: !!moduleExports.execute
      });
    }
  } catch (error) {
    log.error('[WebMCP] Error executing script ${scriptName}:', error);
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

    // Create an injection function that Chrome can serialize
    // We'll pass the wrapped code as an argument to avoid string replacement issues
    const injectionFunc = (codeToInject: string) => {
      const script = document.createElement('script');
      script.textContent = codeToInject;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
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
