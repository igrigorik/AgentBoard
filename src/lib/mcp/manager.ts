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

  constructor(
    private readonly config: MCPConfig | undefined,
    private readonly createClient: ClientFactory = () => new MCPClientService()
  ) {}

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

  async executeTool(
    capability: RemoteMCPToolCapability,
    input: Record<string, unknown>,
    executionSignal?: AbortSignal
  ): Promise<CallToolResult> {
    if (this.signal.aborted || executionSignal?.aborted || !this.capabilitySet.has(capability)) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const client = this.clients.get(capability.serverName);
    if (!client?.isConnected()) throw new Error('MCP server is not connected');

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

  constructor(private readonly createClient: ClientFactory = () => new MCPClientService()) {}

  getCurrentSession(): RemoteMCPSession {
    return this.currentSession;
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
