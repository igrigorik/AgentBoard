/**
 * Remote MCP session lifecycle.
 *
 * A session is built privately and published as one immutable capability snapshot.
 * Reconfiguration revokes the previous snapshot synchronously; transport cleanup is
 * deliberately best-effort so a slow close cannot preserve stale authority.
 */

import log from '../logger';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MCPClientService } from './client';
import {
  CATALOG_FAILURE_COOLDOWN_MS,
  CATALOG_REFRESH_THROTTLE_MS,
  catalogAgeMs,
  clearCatalog,
  readCatalog,
  writeCatalog,
  type RemoteToolCatalog,
} from './catalog';
import type { MCPConfig, MCPServerConfig } from '../storage/config';

export interface MCPServerStatus {
  name: string;
  status: 'connected' | 'disconnected' | 'error';
  error?: string;
  tools: Array<{
    name: string;
    description?: string;
  }>;
  instructions?: string;
}

/** An exact tool capability bound to the session and client that authorized it. */
export interface RemoteMCPToolCapability {
  readonly serverName: string;
  readonly tool: Tool;
}

type ClientFactory = () => MCPClientService;

function normalizedServerEntries(config?: MCPConfig): Array<[string, MCPServerConfig]> {
  return Object.entries(config?.mcpServers ?? {}).sort(([left], [right]) =>
    left.localeCompare(right)
  );
}

/** MCP server-map order is presentation-only and must not trigger reconnects. */
export function sameMCPConfig(left?: MCPConfig, right?: MCPConfig): boolean {
  const leftEntries = normalizedServerEntries(left);
  const rightEntries = normalizedServerEntries(right);
  if (leftEntries.length !== rightEntries.length) return false;

  return leftEntries.every(([leftName, leftServer], index) => {
    const [rightName, rightServer] = rightEntries[index];
    return (
      leftName === rightName &&
      leftServer.transport === rightServer.transport &&
      leftServer.url === rightServer.url &&
      leftServer.authToken === rightServer.authToken
    );
  });
}

function normalizedMCPConfig(config?: MCPConfig): MCPConfig | undefined {
  if (!config || Object.keys(config.mcpServers).length === 0) return undefined;
  return globalThis.structuredClone(config);
}

function cloneStatuses(statuses: MCPServerStatus[]): MCPServerStatus[] {
  return statuses.map((status) => ({
    ...status,
    tools: status.tools.map((tool) => ({ ...tool })),
  }));
}

/**
 * One published remote authority. Public data is never mutated after connect()
 * completes; revoke()/close() affect only lifecycle state and private transports.
 */
export class RemoteMCPSession {
  private readonly controller = new AbortController();
  private readonly clients = new Map<string, MCPClientService>();
  private readonly capabilities: RemoteMCPToolCapability[] = [];
  private readonly capabilitySet = new Set<RemoteMCPToolCapability>();
  private readonly serverInstructions = new Map<string, string>();
  private statuses: MCPServerStatus[] = [];
  private connectStarted = false;
  private closePromise?: Promise<void>;
  /** Live tool list per connected server, used to re-resolve cached capabilities. */
  private readonly liveTools = new Map<string, Tool[]>();
  private readonly connecting = new Map<string, Promise<MCPClientService>>();

  constructor(
    private readonly config: MCPConfig | undefined,
    private readonly createClient: ClientFactory = () => new MCPClientService()
  ) {}

  /**
   * Build a session from a persisted catalog without contacting any server.
   *
   * The result is a real session, not a bare data bag: it keeps `hasContext`
   * true so a stream still attaches its revocation listener, and it remains the
   * object-identity authority anchor. Servers are contacted on first executeTool.
   */
  static fromCatalog(
    catalog: RemoteToolCatalog,
    createClient: ClientFactory = () => new MCPClientService()
  ): RemoteMCPSession {
    const session = new RemoteMCPSession(catalog.mcpConfig, createClient);
    // A catalog-backed session has already "discovered"; connect() must not run.
    session.connectStarted = true;
    for (const { serverName, tool } of catalog.capabilities) {
      const capability = Object.freeze({ serverName, tool });
      session.capabilities.push(capability);
      session.capabilitySet.add(capability);
    }
    for (const [serverName, instructions] of Object.entries(catalog.instructions)) {
      session.serverInstructions.set(serverName, instructions);
    }
    return session;
  }

  /** Serializable projection for the catalog cache. Never includes transports. */
  toCatalog(): RemoteToolCatalog | null {
    if (!this.config) return null;
    return {
      mcpConfig: this.config,
      capabilities: this.capabilities.map(({ serverName, tool }) => ({ serverName, tool })),
      instructions: Object.fromEntries(this.serverInstructions),
      discoveredAt: Date.now(),
    };
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Whether a stream can observe remote tools or instructions from this session. */
  get hasContext(): boolean {
    return this.capabilities.length > 0 || this.serverInstructions.size > 0;
  }

  async connect(): Promise<MCPServerStatus[]> {
    if (this.connectStarted) throw new Error('Remote MCP session connection already started');
    this.connectStarted = true;
    if (!this.config || this.signal.aborted) return [];

    const seenToolNames = new Set<string>();
    const statuses: MCPServerStatus[] = [];

    for (const [name, serverConfig] of Object.entries(this.config.mcpServers)) {
      if (this.signal.aborted) break;

      const client = this.createClient();
      // Track the client before awaiting connect so revoke() can close an in-flight candidate.
      this.clients.set(name, client);
      const connectionStatus = await client.connect(serverConfig, name);

      if (this.signal.aborted) {
        await client.disconnect();
        this.clients.delete(name);
        break;
      }

      if (!connectionStatus.connected || !connectionStatus.tools) {
        this.clients.delete(name);
        statuses.push({
          name,
          status: 'error',
          error: connectionStatus.error || 'Failed to connect',
          tools: [],
        });
        continue;
      }

      if (connectionStatus.instructions) {
        this.serverInstructions.set(name, connectionStatus.instructions);
      }
      this.liveTools.set(name, connectionStatus.tools);

      for (const tool of connectionStatus.tools) {
        // Preserve the existing first-server-wins behavior for duplicate public tool names.
        if (seenToolNames.has(tool.name)) continue;
        seenToolNames.add(tool.name);
        const capability = Object.freeze({ serverName: name, tool });
        this.capabilities.push(capability);
        this.capabilitySet.add(capability);
      }

      statuses.push({
        name,
        status: 'connected',
        tools: connectionStatus.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
        })),
        ...(connectionStatus.instructions && { instructions: connectionStatus.instructions }),
      });
    }

    this.statuses = statuses;
    return cloneStatuses(statuses);
  }

  getToolCapabilities(): readonly RemoteMCPToolCapability[] {
    return this.capabilities;
  }

  getServerStatuses(): MCPServerStatus[] {
    return cloneStatuses(this.statuses);
  }

  getMCPInstructions(): string | undefined {
    const parts: string[] = [];
    for (const [name, instructions] of this.serverInstructions) {
      parts.push(`## MCP Server: ${name}\n${instructions}`);
    }
    return parts.length > 0 ? `# MCP Server Instructions\n\n${parts.join('\n\n')}` : undefined;
  }

  /**
   * Connect one server on demand, deduped so parallel tool calls cannot open
   * parallel transports. Tracks the client before awaiting so revoke()/close()
   * can reach an in-flight candidate.
   */
  private async connectServer(serverName: string): Promise<MCPClientService> {
    const serverConfig = this.config?.mcpServers[serverName];
    if (!serverConfig) throw new Error('MCP server is not configured');

    const client = this.createClient();
    this.clients.set(serverName, client);
    const connectionStatus = await client.connect(serverConfig, serverName);

    if (!connectionStatus.connected || !connectionStatus.tools) {
      this.clients.delete(serverName);
      await client.disconnect();
      throw new Error('MCP server is not connected');
    }

    this.liveTools.set(serverName, connectionStatus.tools);
    if (connectionStatus.instructions) {
      this.serverInstructions.set(serverName, connectionStatus.instructions);
    }
    return client;
  }

  private async ensureServer(serverName: string): Promise<MCPClientService> {
    const existing = this.clients.get(serverName);
    if (existing?.isConnected()) return existing;

    let inFlight = this.connecting.get(serverName);
    if (!inFlight) {
      inFlight = this.connectServer(serverName);
      this.connecting.set(serverName, inFlight);
    }
    try {
      return await inFlight;
    } finally {
      this.connecting.delete(serverName);
    }
  }

  async executeTool(
    capability: RemoteMCPToolCapability,
    input: Record<string, unknown>,
    executionSignal?: AbortSignal
  ): Promise<CallToolResult> {
    if (this.signal.aborted || executionSignal?.aborted || !this.capabilitySet.has(capability)) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const client = await this.ensureServer(capability.serverName);

    // The connect above is itself a revocation window, so re-check both owners
    // before doing anything with the transport.
    if (this.signal.aborted || executionSignal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    if (!client.isConnected()) throw new Error('MCP server is not connected');

    // A cached capability is a hint. Authority is the server's live list: a tool that
    // vanished, or whose input schema moved, would mean the model generated arguments
    // against grounding the server no longer honors.
    const advertised = this.liveTools.get(capability.serverName) ?? [];
    const live = advertised.find((tool) => tool.name === capability.tool.name);
    if (!live) {
      throw new Error(
        `Tool "${capability.tool.name}" is no longer available on MCP server "${capability.serverName}".`
      );
    }
    if (JSON.stringify(live.inputSchema) !== JSON.stringify(capability.tool.inputSchema)) {
      throw new Error(
        `Tool "${capability.tool.name}" changed its input schema on MCP server "${capability.serverName}". Re-save MCP settings to refresh.`
      );
    }

    // The SDK accepts one signal. Link request cancellation with session revocation
    // so either owner can stop an in-flight remote call without leaking listeners.
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.signal.addEventListener('abort', abort, { once: true });
    executionSignal?.addEventListener('abort', abort, { once: true });

    try {
      return await client.callTool(capability.tool.name, input, controller.signal);
    } finally {
      this.signal.removeEventListener('abort', abort);
      executionSignal?.removeEventListener('abort', abort);
    }
  }

  /** Logical revocation is synchronous and independent of transport cooperation. */
  revoke(): void {
    this.controller.abort();
  }

  /** Idempotent best-effort transport cleanup. */
  close(): Promise<void> {
    this.revoke();
    if (!this.closePromise) {
      const clients = Array.from(this.clients.values());
      this.closePromise = Promise.allSettled(clients.map((client) => client.disconnect())).then(
        () => undefined
      );
    }
    return this.closePromise;
  }
}

/** The empty session is stable and never revoked, so adding MCP cannot abort unrelated streams. */
export const EMPTY_REMOTE_MCP_SESSION = new RemoteMCPSession(undefined);

interface PendingSession {
  session: RemoteMCPSession;
  completion: Promise<MCPServerStatus[]>;
}

/** Coordinates latest-desired-session reconciliation for the current extension realm. */
export class RemoteMCPManager {
  private currentSession = EMPTY_REMOTE_MCP_SESSION;
  private pendingSession: PendingSession | null = null;
  private desiredConfig: MCPConfig | undefined;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly createClient: ClientFactory = () => new MCPClientService()) {}

  getCurrentSession(): RemoteMCPSession {
    return this.currentSession;
  }

  /**
   * Make remote tools available for this config, blocking only when there is
   * nothing usable to serve.
   *
   * Materialization happens at most once per config per worker lifetime: if a
   * session already exists we return it untouched, so a background refresh can
   * never swap the session out from under a live stream. A refreshed catalog is
   * picked up by the next worker, which given the ~30s idle timeout is soon.
   */
  async ensure(config?: MCPConfig): Promise<void> {
    const normalizedConfig = normalizedMCPConfig(config);

    if (sameMCPConfig(this.desiredConfig, normalizedConfig)) {
      if (this.pendingSession) {
        await this.pendingSession.completion;
        return;
      }
      if (!normalizedConfig || this.currentSession !== EMPTY_REMOTE_MCP_SESSION) return;
    } else {
      // Configuration changed: detach stale authority synchronously, before the cache
      // read below. Awaiting first would leave a window where a snapshot could still
      // capture a session built from replaced servers or a rotated token.
      this.desiredConfig = undefined;
      this.revokePublishedSession();
      this.revokePendingSession();
    }

    if (!normalizedConfig) {
      this.revoke();
      return;
    }

    const cached = await readCatalog();
    if (cached && sameMCPConfig(cached.mcpConfig, normalizedConfig)) {
      const empty = cached.capabilities.length === 0;
      const age = catalogAgeMs(cached);
      // An empty catalog is the negative cache: retry sooner than a populated one,
      // so a brief outage does not suppress tools for the whole browser session.
      const exhausted = empty && age >= CATALOG_FAILURE_COOLDOWN_MS;
      if (!exhausted) {
        this.publishCatalogSession(cached, normalizedConfig);
        if (!empty && age >= CATALOG_REFRESH_THROTTLE_MS) this.kickRefresh(normalizedConfig);
        return;
      }
    }

    await this.reconcile(normalizedConfig);
  }

  /** Discard the cache and rediscover, even when the config is unchanged. */
  async forceRefresh(config?: MCPConfig): Promise<MCPServerStatus[]> {
    await clearCatalog();
    this.revoke();
    return this.reconcile(config);
  }

  private publishCatalogSession(catalog: RemoteToolCatalog, config: MCPConfig): void {
    // Mirror connectAndPublish's fence: a caller that lost the race must not clobber
    // authority another caller already materialized for the same configuration.
    if (
      sameMCPConfig(this.desiredConfig, config) &&
      this.currentSession !== EMPTY_REMOTE_MCP_SESSION
    ) {
      return;
    }
    this.desiredConfig = config;
    this.revokePublishedSession();
    this.revokePendingSession();
    this.currentSession = RemoteMCPSession.fromCatalog(catalog, this.createClient);
    log.info('[RemoteMCPManager] Remote MCP catalog materialized from cache');
  }

  /**
   * Rediscover into the cache only. Deliberately does not publish: replacing the
   * live session would fire its abort signal and kill an in-flight stream for a
   * hint update. Deduped, and never awaited by callers.
   */
  private kickRefresh(config: MCPConfig): void {
    if (this.refreshing) return;
    const session = new RemoteMCPSession(config, this.createClient);
    this.refreshing = session
      .connect()
      .then(async () => {
        const catalog = session.toCatalog();
        // Never let a momentary failure clobber a good catalog.
        if (catalog && catalog.capabilities.length > 0) await writeCatalog(catalog);
      })
      .catch(() => {
        // Best-effort: the worker may be torn down mid-refresh. Not a server failure.
      })
      .finally(() => {
        this.refreshing = null;
        void session.close();
      });
  }

  /**
   * Revoke the old authority immediately, build the replacement privately, and
   * publish only if it is still the latest requested candidate.
   */
  reconcile(config?: MCPConfig): Promise<MCPServerStatus[]> {
    const normalizedConfig = normalizedMCPConfig(config);
    if (sameMCPConfig(this.desiredConfig, normalizedConfig)) {
      return (
        this.pendingSession?.completion ?? Promise.resolve(this.currentSession.getServerStatuses())
      );
    }

    this.desiredConfig = normalizedConfig;
    this.revokePublishedSession();
    this.revokePendingSession();

    if (!normalizedConfig) return Promise.resolve([]);

    const pending: PendingSession = {
      session: new RemoteMCPSession(normalizedConfig, this.createClient),
      completion: Promise.resolve([]),
    };
    this.pendingSession = pending;
    pending.completion = this.connectAndPublish(pending);
    return pending.completion;
  }

  /** Connect and close an isolated candidate without altering runtime authority. */
  async probe(config: MCPConfig): Promise<MCPServerStatus[]> {
    const session = new RemoteMCPSession(normalizedMCPConfig(config), this.createClient);
    try {
      return await session.connect();
    } finally {
      await session.close();
    }
  }

  /** Fail-closed revocation for missing, malformed, or future configuration. */
  revoke(): void {
    this.desiredConfig = undefined;
    this.revokePublishedSession();
    this.revokePendingSession();
  }

  /** Await transport cleanup for tests or realm shutdown after synchronous revocation. */
  async disconnectAll(): Promise<void> {
    const published = this.currentSession;
    const pending = this.pendingSession?.session;
    this.revoke();
    const closures: Promise<void>[] = [];
    if (published !== EMPTY_REMOTE_MCP_SESSION) closures.push(published.close());
    if (pending) closures.push(pending.close());
    await Promise.all(closures);
  }

  private async connectAndPublish(pending: PendingSession): Promise<MCPServerStatus[]> {
    const statuses = await pending.session.connect();
    if (this.pendingSession !== pending || pending.session.signal.aborted) {
      await pending.session.close();
      return statuses;
    }

    this.pendingSession = null;
    this.currentSession = pending.session;
    log.info('[RemoteMCPManager] Remote MCP session published');
    // Cache the freshly connected session, including an empty result: that is the
    // negative cache that stops an unreachable server re-blocking every message.
    const catalog = pending.session.toCatalog();
    if (catalog) void writeCatalog(catalog);
    return statuses;
  }

  private revokePublishedSession(): void {
    const published = this.currentSession;
    this.currentSession = EMPTY_REMOTE_MCP_SESSION;
    if (published === EMPTY_REMOTE_MCP_SESSION) return;
    published.revoke();
    void published.close();
  }

  private revokePendingSession(): void {
    const pending = this.pendingSession;
    this.pendingSession = null;
    if (!pending) return;
    pending.session.revoke();
    void pending.session.close();
  }
}

let remoteMCPManagerInstance: RemoteMCPManager | null = null;

export function getRemoteMCPManager(): RemoteMCPManager {
  if (!remoteMCPManagerInstance) remoteMCPManagerInstance = new RemoteMCPManager();
  return remoteMCPManagerInstance;
}
