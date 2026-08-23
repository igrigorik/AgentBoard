/**
 * Unified Tool Registry Manager
 *
 * Aggregates AI SDK tools from multiple sources:
 * - Site tools: WebMCP tools from page context
 * - User tools: WebMCP tools from user scripts
 * - Remote tools: MCP server tools from external servers
 *
 * Design Decision: Direct use of AI SDK tool format throughout.
 * Tools are converted to AI SDK format at their source, not in the registry.
 */

import log from '../logger';
import {
  EMPTY_REMOTE_MCP_SESSION,
  getRemoteMCPManager,
  type RemoteMCPManager,
  type RemoteMCPSession,
} from '../mcp/manager';
import { RESERVED_MEMORY_TOOL_NAMES } from '../memory/tool-names';
import { convertMCPToAISDKTool } from '../mcp/tool-bridge';
import { InvalidToolInputSchemaError } from '../schema/tool-input-schema';
import { convertWebMCPToAISDKTool } from './tool-bridge';
import { ConfigStorage, type StorageConfig } from '../storage/config';
import { calculateSpecificityScore } from './tool-patterns';

export type ToolSourceType = 'site' | 'remote' | 'system';

// AI SDK tool type - both MCP and WebMCP converters return the same shape
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AISDKTool = any; // The actual tool type from AI SDK

export interface ToolWithMetadata {
  tool: AISDKTool;
  source: ToolSourceType;
  origin?: string; // tab-{id} for site tools, server name for remote tools, or system
  description?: string; // One-line tool description for LLM grounding in <site_tools>
  /** Public tool name when the internal registry key is scoped by tab. */
  publicName?: string;
}

/** Declarative system registrations are composed outside the generic registry. */
export type SystemToolRegistration =
  | {
      name: string;
      tool: AISDKTool;
      description?: string;
      createForTab?: never;
    }
  | {
      name: string;
      createForTab: (tabId: number) => AISDKTool;
      tool?: never;
      description?: never;
    };

/** One synchronous stream snapshot keeps tools, their execution source, and MCP context coherent. */
export interface ToolSnapshot {
  tools: Record<string, AISDKTool>;
  toolSources: ReadonlyMap<string, ToolSourceType>;
  remoteSession: RemoteMCPSession;
  mcpInstructions?: string;
}

interface ToolSelection {
  tools: Record<string, AISDKTool>;
  toolSources: Map<string, ToolSourceType>;
}

/**
 * Manages unified tool registry across all sources
 */
export class ToolRegistryManager {
  private tools = new Map<string, ToolWithMetadata>();
  private listeners = new Set<(tools: Record<string, AISDKTool>) => void>();
  private remoteSession = EMPTY_REMOTE_MCP_SESSION;

  constructor(private readonly remoteMCPManager: RemoteMCPManager = getRemoteMCPManager()) {}

  /**
   * Tab-bound system tool factories: (tabId) => AISDKTool.
   * These tools need tab context (for navigation or exact-document reading)
   * so they can't be pre-registered as static entries. Instead, getToolsForTab
   * invokes these factories per-call to create ephemeral tool instances.
   */
  private tabBoundFactories = new Map<string, (tabId: number) => AISDKTool>();
  private managedSystemToolNames = new Set<string>();

  /**
   * Tab-scoped tool change subscriptions.
   * Fires when tools for a specific tab are added, removed, or replaced.
   * Primary consumer: streamChat — stops the active stream when tools change
   * so the conversation can restart with a correct tool set.
   */
  private tabChangeCallbacks = new Map<number, Set<() => void>>();

  /** Atomically reconcile extension-owned tools supplied by the system composition layer. */
  replaceSystemTools(registrations: readonly SystemToolRegistration[]): void {
    const nextNames = new Set<string>();
    for (const registration of registrations) {
      if (nextNames.has(registration.name)) {
        throw new Error(`Duplicate system tool registration: ${registration.name}`);
      }
      nextNames.add(registration.name);
    }

    let changed = false;
    let staticOwnershipChanged = false;
    for (const name of this.managedSystemToolNames) {
      if (nextNames.has(name)) continue;
      if (this.tools.get(name)?.source === 'system') {
        this.tools.delete(name);
        changed = true;
        staticOwnershipChanged = true;
      }
      changed = this.tabBoundFactories.delete(name) || changed;
    }

    for (const registration of registrations) {
      if (registration.createForTab) {
        if (this.tools.get(registration.name)?.source === 'system') {
          this.tools.delete(registration.name);
          changed = true;
          staticOwnershipChanged = true;
        }
        if (this.tabBoundFactories.get(registration.name) !== registration.createForTab) {
          this.tabBoundFactories.set(registration.name, registration.createForTab);
          changed = true;
        }
        continue;
      }

      changed = this.tabBoundFactories.delete(registration.name) || changed;
      const existing = this.tools.get(registration.name);
      if (
        existing?.source !== 'system' ||
        existing.tool !== registration.tool ||
        existing.description !== registration.description
      ) {
        if (existing?.source !== 'system') staticOwnershipChanged = true;
        this.addTool(
          registration.name,
          {
            tool: registration.tool,
            source: 'system',
            origin: 'system',
            description: registration.description,
          },
          { silent: true }
        );
        changed = true;
      }
    }

    if (staticOwnershipChanged) {
      this.replaceRemoteSession(this.remoteSession, { force: true, silent: true });
    }
    this.managedSystemToolNames = nextNames;
    if (changed) {
      this.notifyListeners();
      for (const tabId of this.tabChangeCallbacks.keys()) this.notifyTabChange(tabId);
    }
    log.info('[ToolRegistry] System tool configuration applied');
  }

  /**
   * Add or update a tool in the registry.
   *
   * Page tools are keyed internally by tab as well as name. Their public names remain unchanged,
   * but two tabs can no longer overwrite each other's execution closures in the global Map.
   */
  addTool(
    name: string,
    toolWithMeta: ToolWithMetadata,
    { silent = false }: { silent?: boolean } = {}
  ): void {
    const isTabTool = toolWithMeta.source === 'site';
    if (isTabTool && !/^tab-\d+$/.test(toolWithMeta.origin || '')) {
      throw new Error(`Site tool "${name}" requires a tab-scoped origin`);
    }
    if (RESERVED_MEMORY_TOOL_NAMES.has(name) && toolWithMeta.source !== 'system') {
      log.warn('[ToolRegistry] Refusing to register a reserved memory tool name');
      return;
    }
    const storageKey = isTabTool ? `${toolWithMeta.origin}\0${name}` : name;
    const existing = this.tools.get(storageKey);
    if (existing?.source === 'system' && toolWithMeta.source !== 'system') {
      log.warn(`[ToolRegistry] Refusing to replace protected system tool ${name}`);
      return;
    }

    this.tools.set(storageKey, { ...toolWithMeta, publicName: name });
    if (!silent) this.notifyListeners();

    log.warn(
      `[ToolRegistry] Added tool ${name} (${toolWithMeta.source}) from ${toolWithMeta.origin || 'unknown'}`
    );
  }

  /**
   * Remove all tools from a specific origin
   */
  removeToolsByOrigin(origin: string, { silent = false } = {}): void {
    const toRemove: string[] = [];
    for (const [name, meta] of this.tools.entries()) {
      if (meta.origin === origin) {
        toRemove.push(name);
      }
    }

    for (const name of toRemove) {
      this.tools.delete(name);
    }

    if (toRemove.length > 0) {
      log.warn(`[ToolRegistry] Removed ${toRemove.length} tools from origin ${origin}`);

      // Silent removal is one phase of an atomic replacement; both global and tab-scoped
      // listeners are notified once after the complete replacement has been installed.
      if (!silent) {
        this.notifyListeners();
        const tabMatch = origin.match(/^tab-(\d+)$/);
        if (tabMatch) {
          this.notifyTabChange(Number(tabMatch[1]));
        }
      }
    }
  }

  /** Select and sort tools with source metadata from the same winning candidates. */
  private selectToolsBySpecificity(
    filter?: (name: string, meta: ToolWithMetadata) => boolean
  ): ToolSelection {
    type Candidate = {
      name: string;
      tool: AISDKTool;
      score: number;
      meta: ToolWithMetadata;
    };

    const grouped = new Map<string, Candidate[]>();
    for (const [storageKey, meta] of this.tools.entries()) {
      const name = meta.publicName || storageKey;
      if (filter && !filter(name, meta)) continue;
      if (this.tabBoundFactories.has(name) && meta.source !== 'system') continue;

      const candidates = grouped.get(name) || [];
      candidates.push({
        name,
        tool: meta.tool,
        score: calculateSpecificityScore(name, meta.source),
        meta,
      });
      grouped.set(name, candidates);
    }

    const scored: Candidate[] = [];
    for (const candidates of grouped.values()) {
      if (candidates.length === 1) {
        scored.push(candidates[0]);
        continue;
      }

      // A page must never replace an extension-owned global capability with the same public name.
      // Multiple page candidates without a tab scope are ambiguous and therefore fail closed.
      const protectedCandidates = candidates.filter(
        ({ meta }) => meta.source === 'system' || meta.source === 'remote'
      );
      if (protectedCandidates.length === 1) {
        scored.push(protectedCandidates[0]);
      } else {
        log.warn('[ToolRegistry] Ambiguous tool omitted');
      }
    }

    scored.sort((a, b) => b.score - a.score);

    return {
      tools: Object.fromEntries(scored.map(({ name, tool }) => [name, tool])),
      toolSources: new Map(scored.map(({ name, meta }) => [name, meta.source])),
    };
  }

  /**
   * Get all tools as a record for AI SDK consumption
   * Ordered by specificity score (descending)
   */
  getAllTools(): Record<string, AISDKTool> {
    return this.selectToolsBySpecificity().tools;
  }

  /**
   * Get tools scoped to a specific tab (for tab-specific sidebars)
   * Includes both tab-specific tools AND global tools (remote, system)
   *
   * Tool Ordering: Tools are sorted by specificity score (descending).
   * Higher scores appear first, leveraging LLM positional bias.
   * See tool-patterns.ts for scoring logic.
   */
  getToolsForTab(tabId: number): Record<string, AISDKTool> {
    return this.selectToolsForTab(tabId).tools;
  }

  private selectToolsForTab(tabId: number): ToolSelection {
    const selection = this.selectToolsBySpecificity(
      (_, meta) =>
        meta.origin === `tab-${tabId}` || meta.source === 'remote' || meta.source === 'system'
    );

    // Tab-bound factories are extension-owned and overwrite any same-named selected page tool.
    for (const [name, factory] of this.tabBoundFactories) {
      selection.tools[name] = factory(tabId);
      selection.toolSources.set(name, 'system');
    }

    return selection;
  }

  /** Capture each executable and source from one selection pass. */
  captureToolSnapshot(tabId?: number): ToolSnapshot {
    const remoteSession = this.remoteSession;
    const mcpInstructions = remoteSession.getMCPInstructions();
    const selection = tabId ? this.selectToolsForTab(tabId) : this.selectToolsBySpecificity();
    return {
      ...selection,
      remoteSession,
      ...(mcpInstructions && { mcpInstructions }),
    };
  }

  /** Return the selected public executable after applying tab scope and system-name protection. */
  getToolForTab(tabId: number, name: string): AISDKTool | undefined {
    return this.selectToolsForTab(tabId).tools[name];
  }

  /** Whether this exact tab currently owns an accepted page-tool capability. */
  hasSiteTool(tabId: number, name: string): boolean {
    return this.tools.get(`tab-${tabId}\0${name}`)?.source === 'site';
  }

  /** Whether a global system or configured remote capability owns this public name. */
  isProtectedToolName(name: string): boolean {
    const global = this.tools.get(name);
    return (
      global?.source === 'system' ||
      global?.source === 'remote' ||
      this.tabBoundFactories.has(name) ||
      RESERVED_MEMORY_TOOL_NAMES.has(name)
    );
  }

  /**
   * Domain-specific tools for a tab, for LLM steering in <site_tools>.
   *
   * Returns tools registered for this tab whose URL patterns are specific
   * enough to warrant priming the LLM (score > 30). This filters out generic
   * <all_urls> matchers (score 30) while keeping domain/path-specific tools
   * (31-70) and page-provided tools (100).
   *
   * This is a HINT — the full tool set is still sent to the API via getToolsForTab.
   */
  getSiteToolHints(tabId: number): Array<{ name: string; description: string }> {
    const hints: Array<{ name: string; description: string; score: number }> = [];

    for (const [storageKey, meta] of this.tools.entries()) {
      if (meta.origin !== `tab-${tabId}`) continue;

      const name = meta.publicName || storageKey;
      if (this.isProtectedToolName(name)) continue;

      const score = calculateSpecificityScore(name, meta.source);
      if (score <= 30) continue; // Skip generic <all_urls> tools

      hints.push({ name, description: meta.description || name, score });
    }

    return hints
      .sort((a, b) => b.score - a.score)
      .map(({ name, description }) => ({ name, description }));
  }

  /**
   * Register a listener for tool changes
   */
  addListener(listener: (tools: Record<string, AISDKTool>) => void): void {
    this.listeners.add(listener);
  }

  /**
   * Remove a listener
   */
  removeListener(listener: (tools: Record<string, AISDKTool>) => void): void {
    this.listeners.delete(listener);
  }

  /**
   * Subscribe to tool changes for a specific tab.
   * Returns an unsubscribe function — call it when done (e.g., stream ends).
   *
   * Design: Separate from the global `addListener` because consumers like
   * streamChat only care about their own tab's tools changing, not all tools.
   */
  onTabToolsChanged(tabId: number, callback: () => void): () => void {
    let callbacks = this.tabChangeCallbacks.get(tabId);
    if (!callbacks) {
      callbacks = new Set();
      this.tabChangeCallbacks.set(tabId, callbacks);
    }
    callbacks.add(callback);

    return () => {
      const callbacks = this.tabChangeCallbacks.get(tabId);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.tabChangeCallbacks.delete(tabId);
        }
      }
    };
  }

  /**
   * Notify subscribers that a tab's tools changed.
   * Called by removeToolsByOrigin (standalone) and updateWebMCPTools (after new tools are in).
   */
  private notifyTabChange(tabId: number): void {
    const callbacks = this.tabChangeCallbacks.get(tabId);
    if (!callbacks || callbacks.size === 0) return;

    log.info(
      `[ToolRegistry] Notifying ${callbacks.size} subscriber(s) of tool change for tab ${tabId}`
    );
    for (const cb of callbacks) {
      try {
        cb();
      } catch (error) {
        log.error('[ToolRegistry] Error in tab change callback:', error);
      }
    }
  }

  /**
   * Clear all tools
   */
  reset(): void {
    this.tools.clear();
    this.remoteSession = EMPTY_REMOTE_MCP_SESSION;
    this.notifyListeners();
  }

  /**
   * Notify all listeners of tool changes
   */
  private notifyListeners(): void {
    const tools = this.getAllTools();
    for (const listener of this.listeners) {
      try {
        listener(tools);
      } catch (error) {
        log.error('[ToolRegistry] Error in listener:', error);
      }
    }
  }

  /**
   * Reconcile remote MCP authority. A real MCP change clears the published
   * catalog synchronously; a private candidate is installed only after it is ready.
   */
  async loadRemoteTools(configSnapshot?: StorageConfig): Promise<void> {
    try {
      const config = configSnapshot ?? (await ConfigStorage.getInstance().get());
      const completion = this.remoteMCPManager.reconcile(config.mcpConfig);

      // reconcile() synchronously detaches stale authority before its first await.
      this.replaceRemoteSession(this.remoteMCPManager.getCurrentSession());
      await completion;
      this.replaceRemoteSession(this.remoteMCPManager.getCurrentSession());
    } catch {
      this.revokeRemoteTools();
      log.error('[ToolRegistry] Remote MCP reconciliation failed');
    }
  }

  /** Immediately remove all remote capabilities and close transports in the background. */
  revokeRemoteTools(): void {
    this.remoteMCPManager.revoke();
    this.replaceRemoteSession(this.remoteMCPManager.getCurrentSession());
  }

  private replaceRemoteSession(
    session: RemoteMCPSession,
    { force = false, silent = false }: { force?: boolean; silent?: boolean } = {}
  ): void {
    if (!force && this.remoteSession === session) return;

    for (const [name, meta] of this.tools) {
      if (meta.source === 'remote') this.tools.delete(name);
    }

    for (const capability of session.getToolCapabilities()) {
      const { serverName, tool: mcpTool } = capability;
      let convertedTool: AISDKTool;
      try {
        convertedTool = convertMCPToAISDKTool(session, capability);
      } catch (error) {
        if (!(error instanceof InvalidToolInputSchemaError)) throw error;
        // One malformed remote schema must not suppress unrelated capabilities or leak metadata.
        log.warn('[ToolRegistry] Invalid remote MCP tool omitted');
        continue;
      }

      this.addTool(
        `${serverName}_${mcpTool.name}`,
        {
          tool: convertedTool,
          source: 'remote',
          origin: serverName,
          description: mcpTool.description,
        },
        { silent: true }
      );
    }

    this.remoteSession = session;
    if (!silent) {
      this.notifyListeners();
      // Streams that captured the replaced session observe its AbortSignal directly.
      // Publishing the first remote session must not interrupt streams that captured none.
      log.info('[ToolRegistry] Remote MCP snapshot replaced');
    }
  }

  /**
   * Update tools from a WebMCP page context (site tools and user scripts)
   */
  updateWebMCPTools(
    tabId: number,
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
      annotations?: Record<string, unknown>;
    }>
  ): void {
    // Remove existing tools from this tab (silent: notify once after new tools are in)
    this.removeToolsByOrigin(`tab-${tabId}`, { silent: true });

    // Convert and add each WebMCP tool without letting one malformed schema poison the snapshot.
    for (const webmcpTool of tools) {
      let convertedTool: AISDKTool;
      try {
        convertedTool = convertWebMCPToAISDKTool(webmcpTool, tabId);
      } catch (error) {
        if (!(error instanceof InvalidToolInputSchemaError)) throw error;
        log.warn('[ToolRegistry] Invalid WebMCP tool omitted');
        continue;
      }

      this.addTool(
        webmcpTool.name,
        {
          tool: convertedTool,
          source: 'site',
          origin: `tab-${tabId}`,
          description: webmcpTool.description,
        },
        { silent: true }
      );
    }

    log.info('[ToolRegistry] WebMCP snapshot replaced');

    // Publish the replacement atomically instead of exposing partially rebuilt tool sets.
    this.notifyListeners();

    // Fire tab-scoped change notification after new tools are fully registered
    this.notifyTabChange(tabId);
  }
}

// Singleton instance
let registryInstance: ToolRegistryManager | null = null;

export function getToolRegistry(): ToolRegistryManager {
  if (!registryInstance) {
    registryInstance = new ToolRegistryManager();
  }
  return registryInstance;
}
