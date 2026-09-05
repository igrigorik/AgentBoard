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
    __agentboardUserScriptLifetimes?: Map<string, AbortController>;
    __agentboardBuiltinToolLifetimes?: Map<string, AbortController>;
    __agentboardUserScriptSettlements?: Map<string, Promise<void>>;
    __agentboardBuiltinToolSettlements?: Map<string, Promise<void>>;
    __agentboardUserScriptGeneration?: string;
    __webmcpInjected?: Record<string, boolean>;
  }
}

const configStorage = ConfigStorage.getInstance();
const REGISTRATION_SETTLEMENT_TIMEOUT_MS = 5_000;

/** Keep programmatic injection aligned with manifest host permissions and browser-protected stores. */
export function supportsWebMCPInjection(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'http:') return url.hostname === 'localhost';
    if (url.protocol !== 'https:') return false;
    if (url.hostname === 'chromewebstore.google.com') return false;
    if (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore')) return false;
    if (url.hostname === 'microsoftedge.microsoft.com' && url.pathname.startsWith('/addons')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function isProtectedExtensionGalleryError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('extensions gallery cannot be scripted');
}

export interface InjectionOptions {
  tabId: number;
  url: string;
  frameId?: number;
  generation?: string;
  documentId?: string;
  /** Hot reload needs an actionable failure after attempting every script. */
  throwOnFailure?: boolean;
}

/**
 * Wraps a user script module for execution in MAIN world
 * Converts ES module exports to document.modelContext.registerTool() calls
 * All transformations happen here in the background worker,
 * not at runtime in the page.
 */
function wrapScriptForInjection(code: string, metadata: UserScriptMetadata): string {
  // Combine namespace and name for a stable debugging identifier.
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
  if (window.__webmcpInjected && window.__webmcpInjected[scriptId]) return;

  // Mark as injected and bind every registration or async discovery to this script lifetime.
  window.__webmcpInjected = window.__webmcpInjected || {};
  window.__webmcpInjected[scriptId] = true;
  const registrations = window.__agentboardUserScriptLifetimes instanceof Map
    ? window.__agentboardUserScriptLifetimes
    : new Map();
  window.__agentboardUserScriptLifetimes = registrations;
  const settlements = window.__agentboardUserScriptSettlements instanceof Map
    ? window.__agentboardUserScriptSettlements
    : new Map();
  window.__agentboardUserScriptSettlements = settlements;
  const publishSettlement = (settlement) => {
    settlements.set(scriptId, settlement);
    void settlement.catch(() => undefined);
  };
  registrations.get(scriptId)?.abort?.();
  const registrationController = new AbortController();
  registrations.set(scriptId, registrationController);

  try {
    ${transformedCode}

    if (typeof shouldRegister === 'function') {
      try {
        if (!shouldRegister({ signal: registrationController.signal })) {
          publishSettlement(Promise.resolve());
          return;
        }
      } catch {
        // Continue with registration if shouldRegister throws (fail-open)
      }
    }

    const modelContext = document.modelContext;
    if (modelContext && typeof modelContext.registerTool === 'function' && typeof metadata !== 'undefined' && typeof execute !== 'undefined') {
      const tool = {
        name: '${toolName}',
        description: metadata.description || 'Tool: ${toolName}',
        inputSchema: metadata.inputSchema || { type: 'object', properties: {} },
        execute: execute
      };

      try {
        const registration = modelContext.registerTool(tool, {
          signal: registrationController.signal
        });
        publishSettlement(Promise.resolve(registration).then(
          () => undefined,
          (error) => {
            if (registrations.get(scriptId) === registrationController) registrations.delete(scriptId);
            if (registrationController.signal.aborted) return;
            registrationController.abort(error);
            throw error;
          }
        ));
      } catch (error) {
        if (registrations.get(scriptId) === registrationController) registrations.delete(scriptId);
        throw error;
      }
    } else {
      publishSettlement(Promise.reject(new Error('WebMCP registration API is unavailable')));
    }

  } catch (error) {
    if (registrations.get(scriptId) === registrationController) registrations.delete(scriptId);
    registrationController.abort(error);
    publishSettlement(Promise.reject(error));
  }
})();
//# sourceURL=webmcp-script:${scriptName}.js`;
}

/**
 * Get all user scripts for injection
 * Built-in tools are handled separately by lifecycle.ts via pre-compiled files.
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
  const {
    tabId,
    url,
    frameId = 0,
    generation = globalThis.crypto.randomUUID(),
    documentId,
    throwOnFailure = false,
  } = options;
  const failures: unknown[] = [];

  let allScripts: UserScript[];
  try {
    allScripts = await getAllScriptsForInjection();
  } catch (error) {
    log.error('[WebMCP Injector] Failed to get user scripts:', error);
    if (throwOnFailure) throw new Error('User script configuration is unavailable');
    return;
  }

  const enabledScripts = allScripts.filter((s) => s.enabled);
  const matchedPublicNames = new Map<string, string[]>();
  const publicNameByScriptId = new Map<string, string>();
  for (const script of enabledScripts) {
    try {
      const { metadata } = parseUserScript(script.code, true);
      if (!matchesUrl(url, metadata)) continue;
      const publicName = `${metadata.namespace}_${metadata.name}`;
      publicNameByScriptId.set(script.id, publicName);
      const matchingIds = matchedPublicNames.get(publicName) ?? [];
      matchingIds.push(script.id);
      matchedPublicNames.set(publicName, matchingIds);
    } catch {
      // The injection pass below reports malformed scripts with full context.
    }
  }
  const duplicatePublicNames = new Set(
    [...matchedPublicNames].filter(([, ids]) => ids.length > 1).map(([name]) => name)
  );
  log.debug(`[WebMCP Injector] Processing ${enabledScripts.length} enabled scripts for ${url}`);

  for (const script of enabledScripts) {
    const publicName = publicNameByScriptId.get(script.id);
    if (publicName && duplicatePublicNames.has(publicName)) {
      const error = new Error(`Duplicate enabled WebMCP tool name: ${publicName}`);
      failures.push(error);
      log.error(`[WebMCP Injector] Rejected duplicate user script ${script.id}`);
      continue;
    }

    try {
      await injectSingleScript(script, tabId, url, frameId, generation, documentId);
    } catch (error) {
      failures.push(error);
      log.error(`[WebMCP Injector] Failed to inject script ${script.id}:`, error);
    }
  }
  if (throwOnFailure && failures.length > 0) {
    throw new AggregateError(failures, 'One or more user scripts could not be injected');
  }
}

/**
 * Inject a single user script if it matches the URL
 */
async function injectSingleScript(
  script: UserScript,
  tabId: number,
  url: string,
  frameId: number,
  generation: string,
  documentId?: string
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

    const injectionFunc = (
      codeToInject: string,
      expectedGeneration: string,
      scriptId: string,
      settlementTimeoutMs: number
    ) =>
      new Promise<void>((resolve, reject) => {
        let blobUrl: string | undefined;
        let script: HTMLScriptElement | undefined;
        // onerror alone cannot distinguish a CSP refusal from any other load failure, and the two
        // need different remedies. Observing the violation gives the reason first-hand instead of
        // guessing at it in the message.
        let cspRefused = false;
        const onViolation = (event: SecurityPolicyViolationEvent) => {
          if (event.blockedURI === 'blob' || event.blockedURI.startsWith('blob:'))
            cspRefused = true;
        };
        document.addEventListener('securitypolicyviolation', onViolation);
        const cleanup = () => {
          document.removeEventListener('securitypolicyviolation', onViolation);
          const urlToRevoke = blobUrl;
          blobUrl = undefined;
          try {
            if (urlToRevoke) URL.revokeObjectURL(urlToRevoke);
          } catch {
            // Best-effort cleanup only.
          }
          try {
            script?.remove();
          } catch {
            // Best-effort cleanup only.
          }
        };

        try {
          if (window.__agentboardUserScriptGeneration === undefined) {
            window.__agentboardUserScriptGeneration = expectedGeneration;
          }
          if (window.__agentboardUserScriptGeneration !== expectedGeneration) {
            resolve();
            return;
          }
          const guardedCode = `(() => {
            if (window.__agentboardUserScriptGeneration !== ${JSON.stringify(expectedGeneration)}) return;
            ${codeToInject}
          })();`;
          const blob = new Blob([guardedCode], { type: 'application/javascript' });
          blobUrl = URL.createObjectURL(blob);

          // Load script from blob: URL (external source, not inline)
          script = document.createElement('script');

          // Adopt the document's CSP nonce when it has one. Manifest content scripts and built-in
          // tools (injected via files:[]) are already exempt from page CSP; user scripts are the
          // only injection path still subject to it, purely because dynamic code cannot use
          // files:[]. Without this, any origin whose script-src omits blob: silently drops every
          // user script. A nonce short-circuits source matching entirely, so the same blob URL the
          // policy refused is admitted. Chrome blanks the nonce content attribute after parsing to
          // block CSS-selector exfiltration, so read the IDL property first; the attribute is
          // blanked rather than removed, which is why the [nonce] selector still matches.
          const nonceCarrier = document.querySelector<HTMLScriptElement>('script[nonce]');
          const pageNonce = nonceCarrier
            ? nonceCarrier.nonce || nonceCarrier.getAttribute('nonce')
            : '';
          // Must precede insertion: CSP evaluates the element when it enters the document.
          if (pageNonce) script.setAttribute('nonce', pageNonce);

          // Try to set src - may need Trusted Types policy on strict sites
          try {
            // Use TT policy if available (created by webmcp-polyfill.js)
            if (window.__agentboardTTPolicy) {
              script.src = window.__agentboardTTPolicy.createScriptURL(blobUrl);
            } else {
              script.src = blobUrl;
            }
          } catch (trustedTypesError) {
            cleanup();
            reject(trustedTypesError);
            return;
          }

          script.onload = () => {
            cleanup();
            const settlements = window.__agentboardUserScriptSettlements;
            const settlement = settlements?.get(scriptId);
            if (!settlements || !settlement) {
              resolve();
              return;
            }
            let timeout: ReturnType<typeof setTimeout> | undefined;
            const deadline = new Promise<never>((_, rejectDeadline) => {
              timeout = setTimeout(
                () => rejectDeadline(new Error('WebMCP user registration timed out')),
                settlementTimeoutMs
              );
            });
            Promise.race([settlement, deadline]).then(
              () => {
                if (timeout) clearTimeout(timeout);
                if (settlements.get(scriptId) === settlement) settlements.delete(scriptId);
                resolve();
              },
              (error) => {
                if (timeout) clearTimeout(timeout);
                if (settlements.get(scriptId) === settlement) settlements.delete(scriptId);
                window.__agentboardUserScriptLifetimes?.get(scriptId)?.abort(error);
                reject(error);
              }
            );
          };
          script.onerror = () => {
            const blockedByPolicy = cspRefused;
            cleanup();
            reject(
              new Error(
                blockedByPolicy
                  ? "This page's Content Security Policy blocked the script (script-src does not allow blob:, and the page has no nonce to adopt)."
                  : 'Failed to load WebMCP user script from blob URL'
              )
            );
          };

          (document.head || document.documentElement).appendChild(script);
        } catch (error) {
          cleanup();
          reject(error);
        }
      });

    // Inject the script
    await chrome.scripting.executeScript({
      target: documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [frameId] },
      world: 'MAIN',
      injectImmediately,
      func: injectionFunc,
      args: [
        wrappedCode,
        generation,
        `${metadata.namespace}:${metadata.name}`,
        REGISTRATION_SETTLEMENT_TIMEOUT_MS,
      ],
    });

    log.info(`[WebMCP Injector] Successfully injected ${metadata.name}`);
  } catch (error) {
    if (error instanceof ScriptParsingError) {
      log.error(`[WebMCP Injector] Invalid script format:`, error.message);
    }
    throw error;
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

async function getExactDocumentUrl(tabId: number, documentId: string): Promise<string> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, documentIds: [documentId] },
    world: 'ISOLATED',
    injectImmediately: true,
    func: () => globalThis.location.href,
  });
  const result = results.length === 1 ? results[0] : undefined;
  if (
    !result ||
    result.documentId !== documentId ||
    result.frameId !== 0 ||
    typeof result.result !== 'string'
  ) {
    throw new Error('Document route changed');
  }
  return result.result;
}

/**
 * Re-inject scripts into a tab (useful after script updates)
 */
export async function reinjectScripts(
  tabId: number,
  injectBuiltInTools?: (url: string, documentId?: string) => Promise<void>,
  documentId?: string,
  urlChangeAttempts = 0
): Promise<void> {
  try {
    let currentUrl: string | undefined;
    if (documentId) {
      currentUrl = await getExactDocumentUrl(tabId, documentId);
    } else {
      currentUrl = (await chrome.tabs.get(tabId)).url;
    }
    if (!currentUrl) {
      log.debug(`[WebMCP Injector] Tab ${tabId} has no URL`);
      return;
    }
    if (!supportsWebMCPInjection(currentUrl)) {
      log.debug('[WebMCP Injector] Skipping unsupported injection target');
      return;
    }

    const generation = globalThis.crypto.randomUUID();

    // First, clear the injection markers IMMEDIATELY to avoid race conditions
    await chrome.scripting.executeScript({
      target: documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [0] },
      world: 'MAIN',
      injectImmediately: true, // MUST run immediately before re-injection!
      func: (nextGeneration: string) => {
        window.__agentboardUserScriptGeneration = nextGeneration;
        const registrations = window.__agentboardUserScriptLifetimes;
        if (registrations instanceof Map) {
          for (const controller of registrations.values()) controller.abort?.();
          registrations.clear();
        }
        const builtInRegistrations = window.__agentboardBuiltinToolLifetimes;
        if (builtInRegistrations instanceof Map) {
          for (const controller of builtInRegistrations.values()) controller.abort?.();
          builtInRegistrations.clear();
        }
        window.__agentboardUserScriptSettlements?.clear();
        window.__agentboardBuiltinToolSettlements?.clear();

        if (window.__webmcpInjected) {
          window.__webmcpInjected = {};
        }
      },
      args: [generation],
    });

    // Rebuild extension-owned tools before user tools so collision behavior is deterministic.
    await injectBuiltInTools?.(currentUrl, documentId);
    await injectUserScripts({
      tabId,
      url: currentUrl,
      frameId: 0,
      generation,
      documentId,
      throwOnFailure: true,
    });

    if (documentId) {
      const settledUrl = await getExactDocumentUrl(tabId, documentId);
      if (settledUrl !== currentUrl) {
        if (urlChangeAttempts >= 2) {
          throw new Error('Document URL changed repeatedly during hot reload');
        }
        await reinjectScripts(tabId, injectBuiltInTools, documentId, urlChangeAttempts + 1);
      }
    }
  } catch (error) {
    if (isProtectedExtensionGalleryError(error)) {
      // Navigation can race the URL check above; browser extension stores remain protected.
      log.debug('[WebMCP Injector] Skipping protected extension gallery');
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('No tab with id') ||
      message.includes('Tab not found') ||
      message.includes('No document with id') ||
      message.includes('Document route changed') ||
      /frame (?:with ID )?\d+ (?:was removed|not found)/i.test(message)
    ) {
      log.debug('[WebMCP Injector] Skipping a retired tab or frame during hot reload');
      return;
    }
    log.error(`[WebMCP Injector] Failed to re-inject scripts:`, error);
    throw error;
  }
}
