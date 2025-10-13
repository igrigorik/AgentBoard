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
}

export interface ToolRegistry {
  tools: Array<{
    name: string;
    description: string;
    inputSchema?: unknown;
  }>;
  origin: string;
  timestamp: number;
}

/**
 * Manages WebMCP for each tab
 */
export class TabManager {
  private contentPorts = new Map<number, chrome.runtime.Port>();
  private pendingMessages = new Map<number, Array<unknown>>();
  private pendingPromises = new Map<string, PendingPromise>();
  private toolRegistries = new Map<number, ToolRegistry>();
  private pendingInjections = new Set<number>();

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

      log.debug(`[WebMCP Lifecycle] Tab ${tabId} content script connected`);

      // Clean up old port if exists
      const oldPort = this.contentPorts.get(tabId);
      if (oldPort) {
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

      // Handle messages from content script
      port.onMessage.addListener((msg) => {
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
      const promise = this.pendingPromises.get(payload.id);
      if (promise) {
        clearTimeout(promise.timeout);
        if ('error' in payload && payload.error) {
          promise.reject(new Error(payload.error.message));
        } else if ('result' in payload) {
          promise.resolve(payload.result);
        }
        this.pendingPromises.delete(payload.id);
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
    const registry: ToolRegistry = {
      tools: params.tools || [],
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
  }

  /**
   * Set up navigation monitoring for script injection
   */
  private setupNavigationMonitor(): void {
    // Navigation starts - cancel in-flight operations
    chrome.webNavigation.onBeforeNavigate.addListener((details) => {
      if (details.frameId !== 0) return; // Main frame only

      this.cancelPendingCallsForTab(details.tabId);
      this.pendingInjections.add(details.tabId);

      log.debug(`[WebMCP Lifecycle] Navigation starting for tab ${details.tabId}`);
    });

    // DOM is ready - inject our scripts
    chrome.webNavigation.onDOMContentLoaded.addListener(async (details) => {
      if (details.frameId !== 0) return; // Main frame only
      if (!this.pendingInjections.has(details.tabId)) return;

      this.pendingInjections.delete(details.tabId);
      log.debug(`[WebMCP Lifecycle] DOM ready for tab ${details.tabId}, injecting scripts...`);

      await this.injectScripts(details.tabId);
    });
  }

  /**
   * Set up tab cleanup handlers
   */
  private setupTabCleanup(): void {
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.pendingInjections.delete(tabId);
      this.contentPorts.delete(tabId);
      this.pendingMessages.delete(tabId);
      this.toolRegistries.delete(tabId);
      this.cancelPendingCallsForTab(tabId);

      // Remove tools from unified registry for this tab
      const unifiedRegistry = getToolRegistry();
      unifiedRegistry.removeToolsByOrigin(`tab-${tabId}`);

      log.debug(`[WebMCP Lifecycle] Tab ${tabId} removed, cleaned up`);
    });
  }

  /**
   * Cancel all pending tool calls for a tab
   */
  private cancelPendingCallsForTab(tabId: number): void {
    for (const [id, promise] of this.pendingPromises.entries()) {
      if (promise.tabId === tabId) {
        clearTimeout(promise.timeout);
        promise.reject(new Error('Tool call cancelled'));
        this.pendingPromises.delete(id);
      }
    }
  }

  /**
   * Inject WebMCP scripts into a tab
   */
  async injectScripts(tabId: number): Promise<void> {
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

      // 1. Inject the relay content script FIRST (isolated world)
      // CRITICAL: Must be first so it's listening when bridge sends initial snapshot
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'ISOLATED',
        injectImmediately: true,
        files: ['content-scripts/relay.js'],
      });

      // 2. Inject WebMCP polyfill BEFORE any page scripts run
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'MAIN',
        injectImmediately: true, // Run as early as possible
        files: ['content-scripts/webmcp-polyfill.js'],
      });

      // 3. Inject pre-compiled built-in tools (CSP bypass via files:[])
      // Filter tools by URL match patterns AND enabled state
      const tabUrl = tab.url;
      const configStorage = ConfigStorage.getInstance();

      const urlMatchingTools = tabUrl
        ? COMPILED_TOOLS.filter((tool) =>
            matchesUrl(tabUrl, {
              match: tool.match,
              name: tool.id,
              namespace: 'agentboard',
              version: tool.version,
            })
          )
        : [];

      // Further filter by user-enabled state (default: enabled)
      const enabledTools = [];
      for (const tool of urlMatchingTools) {
        const isEnabled = await configStorage.isBuiltinToolEnabled(tool.id);
        if (isEnabled) {
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
          injectImmediately: false, // After polyfill
          files: [tool.file], // Bypasses CSP!
        });
      }

      // 4. Inject page bridge LAST (after relay is ready)
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'MAIN',
        injectImmediately: false, // Wait for DOM to be ready
        files: ['content-scripts/page-bridge.js'],
      });

      log.debug(`[WebMCP Lifecycle] Scripts injected successfully into tab ${tabId}`);

      // 5. Inject user scripts that match this URL
      if (tab.url) {
        await injectUserScripts({
          tabId,
          url: tab.url,
          frameId: 0,
        });
      }
    } catch (error) {
      log.error(`[WebMCP Lifecycle] Failed to inject scripts into tab ${tabId}:`, error);
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
  async callTool(tabId: number, name: string, args: unknown = {}): Promise<unknown> {
    // Fail fast if no content script connection exists
    if (!this.contentPorts.has(tabId)) {
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
      // Set timeout for actual network/execution delays
      const timeout = setTimeout(() => {
        this.pendingPromises.delete(id);
        reject(new Error('Tool call timeout'));
      }, 10000);

      // Store promise handlers
      this.pendingPromises.set(id, { resolve, reject, timeout, tabId });

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

  /**
   * Re-inject user scripts into all active tabs (hot reload)
   * Called when user scripts are modified in options page
   */
  async reinjectAllUserScripts(): Promise<void> {
    log.debug('[WebMCP Lifecycle] Hot reload: Re-injecting user scripts');

    const tabs = await chrome.tabs.query({});

    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;

      // Skip restricted URLs
      if (
        tab.url.startsWith('chrome://') ||
        tab.url.startsWith('chrome-extension://') ||
        tab.url.startsWith('edge://') ||
        tab.url.startsWith('about:')
      ) {
        continue;
      }

      try {
        // Re-inject user scripts (clears markers first)
        await reinjectScripts(tab.id);
        log.debug(`[WebMCP Lifecycle] Re-injected scripts into tab ${tab.id}`);
      } catch (error) {
        log.error(`[WebMCP Lifecycle] Failed to re-inject into tab ${tab.id}:`, error);
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
