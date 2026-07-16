/**
 * WebMCP Tab Manager
 * Manages content script connections, navigation monitoring, and script injection per tab
 */

import log from '../logger';
import type { WebMCPMessage, ToolsListChangedParams } from '../../types/index';
import { injectUserScripts, reinjectScripts } from './script-injector';
import { getToolRegistry } from './tool-registry';
import { COMPILED_TOOLS } from './tools/index';
import { matchesUrl } from './script-parser';
import { ConfigStorage } from '../storage/config';

const JSONRPC = '2.0';

export interface PendingPromise {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  tabId: number;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
}

export interface ToolRegistry {
  tools: Array<{
    name: string;
    description: string;
    inputSchema?: unknown;
    annotations?: Record<string, unknown>;
  }>;
  origin: string;
  timestamp: number;
}

/**
 * Manages WebMCP for each tab
 */
export class TabManager {
  private contentPorts = new Map<number, chrome.runtime.Port>();
  private currentDocumentIds = new Map<number, string>();
  private navigatingTabs = new Set<number>();
  private pendingMessages = new Map<number, Array<unknown>>();
  private pendingPromises = new Map<string, PendingPromise>();
  private toolRegistries = new Map<number, ToolRegistry>();
  private pendingInjections = new Set<number>();
  private scriptOperations = new Map<number, Promise<void>>();
  // Track pending tools/list requests that need responses
  private pendingToolsRequests = new Map<
    number,
    { resolve: (tools: ToolRegistry['tools']) => void; reject: (error: Error) => void }
  >();

  constructor() {
    this.setupPortHandler();
    this.setupNavigationMonitor();
    this.setupTabCleanup();
  }

  /**
   * Set up port connection handler for content scripts
   */
  private setupPortHandler(): void {
    chrome.runtime.onConnect.addListener((port) => {
      // Only handle our WebMCP content script connections
      if (port.name !== 'webmcp-content-script') return;

      const tabId = port.sender?.tab?.id;
      if (!tabId) {
        log.error('[WebMCP Lifecycle] Port connected without tabId:', port.sender);
        return;
      }

      const documentId = port.sender?.documentId;
      const currentDocumentId = this.currentDocumentIds.get(tabId);
      const navigationPending = this.navigatingTabs.has(tabId);
      const isRetiringDocument =
        navigationPending && Boolean(documentId) && documentId === currentDocumentId;
      const isUnexpectedDocument =
        !navigationPending && Boolean(currentDocumentId) && documentId !== currentDocumentId;
      if (documentId && (isRetiringDocument || isUnexpectedDocument)) {
        log.debug(`[WebMCP Lifecycle] Rejecting unowned document ${documentId} for tab ${tabId}`);
        port.disconnect();
        return;
      }
      if (documentId && (navigationPending || documentId !== currentDocumentId)) {
        this.currentDocumentIds.set(tabId, documentId);
        this.navigatingTabs.delete(tabId);
      } else if (!documentId && navigationPending) {
        // Chromium supplies documentId; this fallback preserves operation in test/older runtimes.
        this.currentDocumentIds.delete(tabId);
        this.navigatingTabs.delete(tabId);
      }

      log.debug(`[WebMCP Lifecycle] Tab ${tabId} content script connected`);

      // Clean up old port if exists. A different document cannot inherit outstanding calls or
      // a catalog from its predecessor; cancel while the old port still owns the execution.
      const oldPort = this.contentPorts.get(tabId);
      const oldDocumentId = oldPort?.sender?.documentId;
      if (oldPort) {
        if (oldDocumentId && documentId && oldDocumentId !== documentId) {
          this.cancelPendingCallsForTab(tabId);
          this.toolRegistries.delete(tabId);
          getToolRegistry().removeToolsByOrigin(`tab-${tabId}`);
        }
        try {
          oldPort.disconnect();
        } catch {
          // Port already disconnected
        }
      }

      this.contentPorts.set(tabId, port);

      // Flush pending messages
      const pending = this.pendingMessages.get(tabId);
      if (pending?.length) {
        log.debug(`[WebMCP Lifecycle] Flushing ${pending.length} messages to tab ${tabId}`);
        pending.forEach((msg) => {
          try {
            port.postMessage(msg);
          } catch (e) {
            log.error('[WebMCP Lifecycle] Failed to flush message:', e);
          }
        });
        this.pendingMessages.delete(tabId);
      }

      // Request current tools from page to handle service worker wake-up scenarios
      // Chrome hibernates service workers after ~30s, losing all in-memory state.
      // By requesting tools on every port connection, we ensure tools are re-registered
      // even if the service worker lost its toolRegistries Map.
      this.requestToolsFromTab(tabId);

      // A disconnected or navigated document may still have queued messages. Only the currently
      // owned port may mutate this tab's registry or settle its tool calls.
      port.onMessage.addListener((msg) => {
        if (this.contentPorts.get(tabId) !== port) return;
        if (this.navigatingTabs.has(tabId)) return;
        const ownedDocumentId = this.currentDocumentIds.get(tabId);
        if (documentId && ownedDocumentId && documentId !== ownedDocumentId) return;
        this.handleContentMessage(tabId, msg);
      });

      // Handle port disconnection
      port.onDisconnect.addListener(() => {
        log.debug(`[WebMCP Lifecycle] Tab ${tabId} port disconnected`);

        // Only remove if it's the same port instance
        if (this.contentPorts.get(tabId) === port) {
          this.contentPorts.delete(tabId);

          // Cancel any pending tool calls for this tab
          // (could be navigation, tab close, or content script crash)
          this.cancelPendingCallsForTab(tabId);
        }
      });
    });
  }

  /**
   * Request current tool list from a tab
   * Critical for handling service worker hibernation where in-memory
   * state is lost but page/content scripts remain alive.
   */
  private requestToolsFromTab(tabId: number): void {
    const port = this.contentPorts.get(tabId);
    if (!port) return;

    const notification = {
      type: 'webmcp',
      payload: {
        jsonrpc: JSONRPC,
        method: 'tools/list',
        params: {},
      },
    };

    try {
      port.postMessage(notification);
      log.debug(`[WebMCP Lifecycle] Requested tools list from tab ${tabId}`);
    } catch (e) {
      log.error(`[WebMCP Lifecycle] Failed to request tools from tab ${tabId}:`, e);
    }
  }

  /**
   * Request tools from a tab and wait for the response
   * Returns the tools array when tools/listChanged notification arrives
   */
  async requestToolsAndWait(
    tabId: number,
    timeoutMs: number = 5000
  ): Promise<ToolRegistry['tools']> {
    // If we already have tools, return them immediately
    const existing = this.toolRegistries.get(tabId);
    if (existing && existing.tools.length > 0) {
      return existing.tools;
    }

    // Create a promise that will be resolved when tools/listChanged arrives
    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingToolsRequests.delete(tabId);
        reject(new Error(`Timeout waiting for tools from tab ${tabId}`));
      }, timeoutMs);

      // Store the promise handlers
      this.pendingToolsRequests.set(tabId, {
        resolve: (tools) => {
          clearTimeout(timeout);
          resolve(tools);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      // Send the request
      this.requestToolsFromTab(tabId);
    });
  }

  /**
   * Wait for a navigation to complete on a tab.
   * Resolves with the final URL after onCompleted fires (main frame).
   * Rejects on navigation error or timeout.
   */
  async waitForNavigation(tabId: number, timeoutMs: number = 30000): Promise<{ url: string }> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        chrome.webNavigation.onCompleted.removeListener(onCompleted);
        chrome.webNavigation.onErrorOccurred.removeListener(onError);
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Navigation timeout after ${timeoutMs}ms for tab ${tabId}`));
      }, timeoutMs);

      const onCompleted = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
        if (details.tabId !== tabId || details.frameId !== 0) return;
        cleanup();
        resolve({ url: details.url });
      };

      const onError = (details: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails) => {
        if (details.tabId !== tabId || details.frameId !== 0) return;
        cleanup();
        reject(new Error(`Navigation failed for tab ${tabId}: ${details.url}`));
      };

      chrome.webNavigation.onCompleted.addListener(onCompleted);
      chrome.webNavigation.onErrorOccurred.addListener(onError);
    });
  }

  /**
   * Handle messages from content scripts
   */
  private handleContentMessage(tabId: number, msg: WebMCPMessage): void {
    if (msg?.type !== 'webmcp') return;

    const payload = msg.payload;
    if (!payload) return;

    // Type guard for responses (have id and either result or error)
    const isResponse = 'id' in payload && ('result' in payload || 'error' in payload);

    // Type guard for notifications (have method but no id)
    const isNotification = 'method' in payload && !('id' in payload);

    // Handle responses (with id)
    if (isResponse) {
      const promise = this.takePendingPromise(payload.id);
      if (promise) {
        if ('error' in payload && payload.error) {
          // Preserve structured error data from the page for debugging
          const err: Error & { data?: unknown; code?: number } = new Error(payload.error.message);
          if (payload.error.data) err.data = payload.error.data;
          if (payload.error.code) err.code = payload.error.code;
          promise.reject(err);
        } else if ('result' in payload) {
          promise.resolve(payload.result);
        }
      }
    }

    // Handle notifications (no id)
    if (isNotification && payload.method === 'tools/listChanged') {
      log.warn(`[WebMCP Lifecycle] Received tools/listChanged from tab ${tabId}`, payload.params);
      this.updateToolRegistry(tabId, payload.params as ToolsListChangedParams);
    }
  }

  /**
   * Update tool registry for a tab
   */
  private updateToolRegistry(tabId: number, params: ToolsListChangedParams): void {
    // Parse inputSchema if it's a JSON string (Chrome's native API returns it as string)
    const normalizedTools = (params.tools || []).map((tool) => {
      let inputSchema = tool.inputSchema;
      if (typeof inputSchema === 'string') {
        try {
          inputSchema = JSON.parse(inputSchema);
          log.debug(`[WebMCP Lifecycle] Parsed inputSchema for tool "${tool.name}"`);
        } catch (e) {
          log.warn(`[WebMCP Lifecycle] Failed to parse inputSchema for tool "${tool.name}":`, e);
        }
      }
      return { ...tool, inputSchema };
    });

    const registry: ToolRegistry = {
      tools: normalizedTools,
      origin: params.origin || '',
      timestamp: params.timestamp ?? Date.now(),
    };

    this.toolRegistries.set(tabId, registry);

    log.debug(
      `[WebMCP Lifecycle] Tab ${tabId} registry updated:`,
      `${registry.tools.length} tools from ${registry.origin}`
    );

    // Update unified registry with WebMCP tools
    const unifiedRegistry = getToolRegistry();
    unifiedRegistry.updateWebMCPTools(tabId, registry.tools, registry.origin);

    // Resolve any pending tools/list requests for this tab
    const pending = this.pendingToolsRequests.get(tabId);
    if (pending) {
      pending.resolve(registry.tools);
      this.pendingToolsRequests.delete(tabId);
    }
  }

  /**
   * Set up navigation monitoring for script injection
   */
  private setupNavigationMonitor(): void {
    // Navigation starts - cancel in-flight operations
    chrome.webNavigation.onBeforeNavigate.addListener((details) => {
      if (details.frameId !== 0) return; // Main frame only

      this.cancelPendingCallsForTab(details.tabId);
      // Invalidate the old document immediately; queued messages can otherwise repopulate the
      // tab registry before its replacement relay connects. While navigation is pending, the
      // current document ID identifies and rejects reconnects from that retiring document.
      this.navigatingTabs.add(details.tabId);
      // Clear stale tool registry so requestToolsAndWait doesn't return old data
      this.toolRegistries.delete(details.tabId);
      this.pendingInjections.add(details.tabId);

      // Clear stale tools from the unified registry immediately.
      // This fires notifyTabChange → sets toolsInvalidated in any active stream,
      // ensuring the stream stops before calling stale tools on the old page.
      const unifiedRegistry = getToolRegistry();
      unifiedRegistry.removeToolsByOrigin(`tab-${details.tabId}`);

      log.debug(`[WebMCP Lifecycle] Navigation starting for tab ${details.tabId}`);
    });

    // DOM is ready - inject our scripts
    chrome.webNavigation.onDOMContentLoaded.addListener(async (details) => {
      if (details.frameId !== 0) return; // Main frame only
      if (!this.pendingInjections.has(details.tabId)) return;

      this.pendingInjections.delete(details.tabId);
      // The replacement relay port, rather than event ordering, completes document ownership.
      // Until it connects, calls and messages remain blocked from the retiring document.
      log.debug(`[WebMCP Lifecycle] DOM ready for tab ${details.tabId}, injecting scripts...`);

      await this.injectScripts(details.tabId);
    });

    // A cancelled provisional navigation leaves the old document alive. Restore its ownership and
    // request a fresh catalog instead of orphaning its still-connected relay.
    chrome.webNavigation.onErrorOccurred?.addListener((details) => {
      if (details.frameId !== 0) return;
      if (!this.navigatingTabs.has(details.tabId)) return;

      this.navigatingTabs.delete(details.tabId);
      this.pendingInjections.delete(details.tabId);
      const survivingPort = this.contentPorts.get(details.tabId);
      const documentId = survivingPort?.sender?.documentId;
      if (documentId) this.currentDocumentIds.set(details.tabId, documentId);
      this.requestToolsFromTab(details.tabId);
      log.debug(`[WebMCP Lifecycle] Navigation cancelled for tab ${details.tabId}`);
    });
  }

  /**
   * Set up tab cleanup handlers
   */
  private setupTabCleanup(): void {
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.pendingInjections.delete(tabId);
      this.scriptOperations.delete(tabId);
      this.contentPorts.delete(tabId);
      this.currentDocumentIds.delete(tabId);
      this.navigatingTabs.delete(tabId);
      this.pendingMessages.delete(tabId);
      this.toolRegistries.delete(tabId);
      this.cancelPendingCallsForTab(tabId);

      // Reject any pending tools requests
      const pendingTools = this.pendingToolsRequests.get(tabId);
      if (pendingTools) {
        pendingTools.reject(new Error('Tab closed'));
        this.pendingToolsRequests.delete(tabId);
      }

      // Remove tools from unified registry for this tab
      const unifiedRegistry = getToolRegistry();
      unifiedRegistry.removeToolsByOrigin(`tab-${tabId}`);

      log.debug(`[WebMCP Lifecycle] Tab ${tabId} removed, cleaned up`);
    });
  }

  private takePendingPromise(id: string): PendingPromise | undefined {
    const promise = this.pendingPromises.get(id);
    if (!promise) return undefined;

    clearTimeout(promise.timeout);
    if (promise.abortSignal && promise.abortHandler) {
      promise.abortSignal.removeEventListener('abort', promise.abortHandler);
    }
    this.pendingPromises.delete(id);
    return promise;
  }

  private sendToolCancellation(tabId: number, id: string): void {
    const port = this.contentPorts.get(tabId);
    if (!port) return;

    try {
      port.postMessage({
        type: 'webmcp',
        payload: {
          jsonrpc: JSONRPC,
          method: 'tools/cancel',
          params: { id },
        },
      });
    } catch (error) {
      log.debug(`[WebMCP Lifecycle] Failed to cancel tool call ${id}:`, error);
    }
  }

  /**
   * Cancel all pending tool calls for a tab
   */
  private cancelPendingCallsForTab(tabId: number): void {
    for (const [id, pending] of this.pendingPromises.entries()) {
      if (pending.tabId !== tabId) continue;

      const promise = this.takePendingPromise(id);
      if (!promise) continue;
      this.sendToolCancellation(tabId, id);
      promise.reject(new Error('Tool call cancelled'));
    }
  }

  private runScriptOperation(tabId: number, operation: () => Promise<void>): Promise<void> {
    const previous = this.scriptOperations.get(tabId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.scriptOperations.set(tabId, current);

    return current.finally(() => {
      if (this.scriptOperations.get(tabId) === current) this.scriptOperations.delete(tabId);
    });
  }

  private async injectBuiltInTools(tabId: number, tabUrl: string): Promise<void> {
    const configStorage = ConfigStorage.getInstance();
    const urlMatchingTools = COMPILED_TOOLS.filter((tool) =>
      matchesUrl(tabUrl, {
        match: tool.match,
        name: tool.id,
        namespace: 'agentboard',
        version: tool.version,
      })
    );

    const enabledTools = [];
    for (const tool of urlMatchingTools) {
      if (await configStorage.isBuiltinToolEnabled(tool.id)) {
        enabledTools.push(tool);
      } else {
        log.debug(`[WebMCP Lifecycle] Skipping disabled built-in tool: ${tool.id}`);
      }
    }

    log.debug(
      `[WebMCP Lifecycle] Injecting ${enabledTools.length}/${COMPILED_TOOLS.length} compiled tools ` +
        `(${urlMatchingTools.length} matched URL, ${enabledTools.length} enabled)`
    );

    for (const tool of enabledTools) {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'MAIN',
        injectImmediately: false,
        files: [tool.file],
      });
    }
  }

  /**
   * Inject WebMCP scripts into a tab
   */
  async injectScripts(tabId: number): Promise<void> {
    return this.runScriptOperation(tabId, () => this.injectScriptsNow(tabId));
  }

  private async injectScriptsNow(tabId: number): Promise<void> {
    try {
      // Get tab info to check URL
      const tab = await chrome.tabs.get(tabId);
      if (!tab?.url) return;

      // Skip chrome:// and other restricted URLs
      if (
        tab.url.startsWith('chrome://') ||
        tab.url.startsWith('chrome-extension://') ||
        tab.url.startsWith('edge://') ||
        tab.url.startsWith('about:')
      ) {
        log.debug(`[WebMCP Lifecycle] Skipping injection for restricted URL: ${tab.url}`);
        return;
      }

      log.debug(`[WebMCP Lifecycle] Injecting scripts into tab ${tabId} (${tab.url})`);

      // Polyfill is injected via manifest content_scripts (world: MAIN, run_at: document_start)
      // so it's guaranteed to be available before any page scripts run.

      // 1. Inject the relay content script (isolated world)
      // CRITICAL: Must be first so it's listening when bridge sends initial snapshot
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'ISOLATED',
        injectImmediately: true,
        files: ['content-scripts/relay.js'],
      });

      // 2. Inject URL-matched, enabled built-in tools via files:[] to bypass page CSP.
      await this.injectBuiltInTools(tabId, tab.url);

      // 3. Inject page bridge LAST (after relay is ready)
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'MAIN',
        injectImmediately: false, // Wait for DOM to be ready
        files: ['content-scripts/page-bridge.js'],
      });

      log.debug(`[WebMCP Lifecycle] Scripts injected successfully into tab ${tabId}`);

      // 4. Inject user scripts that match this URL
      if (tab.url) {
        await injectUserScripts({
          tabId,
          url: tab.url,
          frameId: 0,
        });
      }
    } catch (error) {
      // "No tab with id" is expected for prerendered/discarded tabs — not an error
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('No tab with id')) {
        log.debug(`[WebMCP Lifecycle] Tab ${tabId} gone before injection (prerender/discard)`);
      } else {
        log.error(`[WebMCP Lifecycle] Failed to inject scripts into tab ${tabId}:`, error);
      }
    }
  }

  /**
   * Send a message to a tab
   */
  async sendToTab(tabId: number, message: unknown): Promise<void> {
    const port = this.contentPorts.get(tabId);

    if (port) {
      try {
        port.postMessage(message);
        return;
      } catch (e) {
        log.error('[WebMCP Lifecycle] Failed to send to port:', e);
      }
    }

    // No connection, queue and trigger injection
    log.debug(`[WebMCP Lifecycle] No connection to tab ${tabId}, queueing message`);
    if (!this.pendingMessages.has(tabId)) {
      this.pendingMessages.set(tabId, []);
    }
    const pendingArray = this.pendingMessages.get(tabId);
    if (pendingArray) {
      pendingArray.push(message);
    }

    // Trigger injection
    await this.ensureContentScriptReady(tabId);
  }

  /**
   * Ensure content scripts are ready in a tab
   */
  async ensureContentScriptReady(tabId: number): Promise<void> {
    // Check if already connected
    if (this.contentPorts.has(tabId)) {
      return;
    }

    // Inject scripts
    await this.injectScripts(tabId);
  }

  /**
   * Call a tool in a specific tab
   */
  async callTool(
    tabId: number,
    name: string,
    args: unknown = {},
    abortSignal?: AbortSignal
  ): Promise<unknown> {
    if (abortSignal?.aborted) throw abortSignal.reason;

    // Fail fast if no content script connection exists or its document is navigating away.
    if (!this.contentPorts.has(tabId) || this.navigatingTabs.has(tabId)) {
      log.error(
        `[WebMCP Lifecycle] No content port for tab ${tabId}. Available ports:`,
        Array.from(this.contentPorts.keys())
      );
      throw new Error(`No connection to tab ${tabId}. The page may have been closed or reloaded.`);
    }

    const id = globalThis.crypto.randomUUID();
    const request = {
      jsonrpc: JSONRPC,
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.takePendingPromise(id);
        if (!pending) return;
        this.sendToolCancellation(tabId, id);
        pending.reject(new Error('Tool call timeout'));
      }, 10000);

      const abortHandler = abortSignal
        ? () => {
            const pending = this.takePendingPromise(id);
            if (!pending) return;
            this.sendToolCancellation(tabId, id);
            pending.reject(abortSignal.reason);
          }
        : undefined;

      this.pendingPromises.set(id, {
        resolve,
        reject,
        timeout,
        tabId,
        abortSignal,
        abortHandler,
      });
      if (abortSignal && abortHandler) {
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      }

      // Send via port
      this.sendToTab(tabId, { type: 'webmcp', payload: request });
    });
  }

  /**
   * Get tool registry for a tab
   */
  getToolRegistry(tabId: number): ToolRegistry | undefined {
    return this.toolRegistries.get(tabId);
  }

  /**
   * Get all tool registries
   */
  getAllRegistries(): Map<number, ToolRegistry> {
    return new Map(this.toolRegistries);
  }

  /** Rebuild built-in and user-script registrations after an options change. */
  async reinjectAllScripts(): Promise<void> {
    log.debug('[WebMCP Lifecycle] Hot reload: Re-injecting WebMCP scripts');

    const tabs = await chrome.tabs.query({});

    for (const tab of tabs) {
      const tabId = tab.id;
      const tabUrl = tab.url;
      if (!tabId || !tabUrl) continue;

      // Skip restricted URLs
      if (
        tabUrl.startsWith('chrome://') ||
        tabUrl.startsWith('chrome-extension://') ||
        tabUrl.startsWith('edge://') ||
        tabUrl.startsWith('about:')
      ) {
        continue;
      }

      try {
        await this.runScriptOperation(tabId, () =>
          reinjectScripts(tabId, (currentUrl) => this.injectBuiltInTools(tabId, currentUrl))
        );
        log.debug(`[WebMCP Lifecycle] Re-injected scripts into tab ${tabId}`);
      } catch (error) {
        log.error(`[WebMCP Lifecycle] Failed to re-inject into tab ${tabId}:`, error);
      }
    }
  }
}

// Singleton instance for global access
let tabManagerInstance: TabManager | null = null;

export function getTabManager(): TabManager {
  if (!tabManagerInstance) {
    tabManagerInstance = new TabManager();
  }
  return tabManagerInstance;
}
