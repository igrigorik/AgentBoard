import type { MCPClientStatus } from '../src/lib/mcp/client';
import type { MCPClientService } from '../src/lib/mcp/client';
import { EMPTY_REMOTE_MCP_SESSION, RemoteMCPManager, sameMCPConfig } from '../src/lib/mcp/manager';
import type { MCPConfig, MCPServerConfig, StorageConfig } from '../src/lib/storage/config';
import { ToolRegistryManager } from '../src/lib/webmcp/tool-registry';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function config(name: string, url = `https://${name}.example.test/mcp`): MCPConfig {
  return {
    mcpServers: {
      [name]: { transport: 'http', url },
    },
  };
}

function storageConfig(mcpConfig?: MCPConfig): StorageConfig {
  return {
    schemaVersion: 2,
    agents: [],
    ...(mcpConfig && { mcpConfig }),
  };
}

function connectedStatus(
  name: string,
  toolName = 'search',
  instructions = `${name} instructions`
): MCPClientStatus {
  return {
    connected: true,
    serverName: name,
    tools: [{ name: toolName, description: `${name} tool`, inputSchema: { type: 'object' } }],
    instructions,
  };
}

class FakeClient {
  connected = false;
  readonly disconnect = vi.fn(async () => {
    this.connected = false;
  });
  readonly callTool = vi.fn(async () => ({
    isError: false,
    content: [{ type: 'text' as const, text: 'ok' }],
  }));

  constructor(
    private readonly connectResult: (
      serverConfig: MCPServerConfig,
      serverName?: string
    ) => Promise<MCPClientStatus>
  ) {}

  async connect(serverConfig: MCPServerConfig, serverName?: string): Promise<MCPClientStatus> {
    const status = await this.connectResult(serverConfig, serverName);
    this.connected = status.connected;
    return status;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

function harness() {
  const responses = new Map<string, Deferred<MCPClientStatus> | MCPClientStatus>();
  const clients: FakeClient[] = [];
  const manager = new RemoteMCPManager(() => {
    const client = new FakeClient(async (serverConfig, serverName) => {
      const response = responses.get(serverConfig.url);
      if (!response) throw new Error(`Missing fake response for ${serverName}`);
      return 'promise' in response ? response.promise : response;
    });
    clients.push(client);
    return client as unknown as MCPClientService;
  });

  return { manager, responses, clients };
}

describe('Remote MCP session reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('treats server-map order as semantic equality', () => {
    const left: MCPConfig = {
      mcpServers: {
        alpha: { transport: 'http', url: 'https://alpha.example.test/mcp' },
        beta: {
          transport: 'http',
          url: 'https://beta.example.test/mcp',
          authToken: 'token',
        },
      },
    };
    const right: MCPConfig = {
      mcpServers: {
        beta: {
          transport: 'http',
          url: 'https://beta.example.test/mcp',
          authToken: 'token',
        },
        alpha: { transport: 'http', url: 'https://alpha.example.test/mcp' },
      },
    };

    expect(sameMCPConfig(left, right)).toBe(true);
    expect(sameMCPConfig(left, config('alpha'))).toBe(false);
  });

  it('does not reconnect an unchanged MCP configuration', async () => {
    const { manager, responses, clients } = harness();
    const alpha = config('alpha');
    responses.set(alpha.mcpServers.alpha.url, connectedStatus('alpha'));

    await manager.reconcile(alpha);
    const firstSession = manager.getCurrentSession();
    await manager.reconcile(globalThis.structuredClone(alpha));

    expect(manager.getCurrentSession()).toBe(firstSession);
    expect(clients).toHaveLength(1);
    await manager.disconnectAll();
  });

  it('revokes the active session synchronously before its replacement connects', async () => {
    const { manager, responses } = harness();
    const alpha = config('alpha');
    const beta = config('beta');
    const betaConnect = deferred<MCPClientStatus>();
    responses.set(alpha.mcpServers.alpha.url, connectedStatus('alpha'));
    responses.set(beta.mcpServers.beta.url, betaConnect);
    await manager.reconcile(alpha);
    const oldSession = manager.getCurrentSession();

    const replacement = manager.reconcile(beta);

    expect(oldSession.signal.aborted).toBe(true);
    expect(manager.getCurrentSession()).toBe(EMPTY_REMOTE_MCP_SESSION);

    betaConnect.resolve(connectedStatus('beta'));
    await replacement;
    expect(manager.getCurrentSession()).not.toBe(EMPTY_REMOTE_MCP_SESSION);
    expect(manager.getCurrentSession().getServerStatuses()[0].name).toBe('beta');
    await manager.disconnectAll();
  });

  it('never publishes a slow candidate after a newer request', async () => {
    const { manager, responses, clients } = harness();
    const alpha = config('alpha');
    const beta = config('beta');
    const alphaConnect = deferred<MCPClientStatus>();
    const betaConnect = deferred<MCPClientStatus>();
    responses.set(alpha.mcpServers.alpha.url, alphaConnect);
    responses.set(beta.mcpServers.beta.url, betaConnect);

    const alphaLoad = manager.reconcile(alpha);
    const alphaClient = clients[0];
    const betaLoad = manager.reconcile(beta);

    expect(alphaClient.disconnect).toHaveBeenCalledTimes(1);
    alphaConnect.resolve(connectedStatus('alpha'));
    await alphaLoad;
    expect(manager.getCurrentSession()).toBe(EMPTY_REMOTE_MCP_SESSION);

    betaConnect.resolve(connectedStatus('beta'));
    await betaLoad;
    expect(manager.getCurrentSession().getServerStatuses()[0].name).toBe('beta');
    await manager.disconnectAll();
  });

  it('empty configuration revokes tools and instructions without waiting for close', async () => {
    const { manager, responses } = harness();
    const alpha = config('alpha');
    responses.set(alpha.mcpServers.alpha.url, connectedStatus('alpha'));
    await manager.reconcile(alpha);
    const oldSession = manager.getCurrentSession();

    const removal = manager.reconcile({ mcpServers: {} });

    expect(oldSession.signal.aborted).toBe(true);
    expect(manager.getCurrentSession()).toBe(EMPTY_REMOTE_MCP_SESSION);
    expect(manager.getCurrentSession().getToolCapabilities()).toEqual([]);
    expect(manager.getCurrentSession().getMCPInstructions()).toBeUndefined();
    await removal;
  });

  it('an old same-name capability cannot execute against the replacement client', async () => {
    const { manager, responses, clients } = harness();
    const alpha = config('alpha');
    const beta = config('beta');
    responses.set(alpha.mcpServers.alpha.url, connectedStatus('alpha', 'search'));
    responses.set(beta.mcpServers.beta.url, connectedStatus('beta', 'search'));
    await manager.reconcile(alpha);
    const alphaSession = manager.getCurrentSession();
    const [alphaCapability] = alphaSession.getToolCapabilities();

    await manager.reconcile(beta);
    const betaClient = clients[1];

    await expect(alphaSession.executeTool(alphaCapability, {})).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(betaClient.callTool).not.toHaveBeenCalled();
    await manager.disconnectAll();
  });

  it('probes with an isolated session and preserves published runtime authority', async () => {
    const { manager, responses, clients } = harness();
    const alpha = config('alpha');
    const probeConfig = config('probe');
    responses.set(alpha.mcpServers.alpha.url, connectedStatus('alpha'));
    responses.set(probeConfig.mcpServers.probe.url, connectedStatus('probe'));
    await manager.reconcile(alpha);
    const published = manager.getCurrentSession();

    const statuses = await manager.probe(probeConfig);

    expect(statuses[0].name).toBe('probe');
    expect(manager.getCurrentSession()).toBe(published);
    expect(published.signal.aborted).toBe(false);
    expect(clients[1].disconnect).toHaveBeenCalledTimes(1);
    await manager.disconnectAll();
  });

  it('force revocation invalidates desired config so the same valid config reconnects', async () => {
    const { manager, responses, clients } = harness();
    const alpha = config('alpha');
    responses.set(alpha.mcpServers.alpha.url, connectedStatus('alpha'));
    await manager.reconcile(alpha);
    const oldSession = manager.getCurrentSession();

    manager.revoke();
    await manager.reconcile(alpha);

    expect(oldSession.signal.aborted).toBe(true);
    expect(clients).toHaveLength(2);
    expect(manager.getCurrentSession()).not.toBe(oldSession);
    await manager.disconnectAll();
  });
});

describe('remote MCP registry snapshots', () => {
  it('publishes tools and instructions from one session atomically', async () => {
    const { manager, responses } = harness();
    const alpha = config('alpha');
    responses.set(alpha.mcpServers.alpha.url, connectedStatus('alpha', 'search', 'Use search.'));
    const registry = new ToolRegistryManager(manager);
    const listener = vi.fn();
    registry.addListener(listener);

    await registry.loadRemoteTools(storageConfig(alpha));
    const snapshot = registry.captureToolSnapshot(42);

    expect(snapshot.remoteSession).toBe(manager.getCurrentSession());
    expect(snapshot.mcpInstructions).toContain('Use search.');
    expect(snapshot.tools).toHaveProperty('alpha_search');
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ alpha_search: expect.anything() })
    );
    await manager.disconnectAll();
  });

  it('omits one malformed remote schema without suppressing valid capabilities', async () => {
    const { manager, responses } = harness();
    const alpha = config('alpha');
    const status = connectedStatus('alpha');
    status.tools = [
      { name: 'first', inputSchema: { type: 'object' } },
      {
        name: 'malformed',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string', pattern: '^(a+)+$' } },
        },
      },
      { name: 'second', inputSchema: { type: 'object' } },
    ];
    responses.set(alpha.mcpServers.alpha.url, status);
    const registry = new ToolRegistryManager(manager);
    const listener = vi.fn();
    registry.addListener(listener);

    await registry.loadRemoteTools(storageConfig(alpha));

    const snapshot = registry.captureToolSnapshot(42);
    expect(Object.keys(snapshot.tools)).toEqual(['alpha_first', 'alpha_second']);
    expect(snapshot.remoteSession).toBe(manager.getCurrentSession());
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ alpha_first: expect.anything(), alpha_second: expect.anything() })
    );
    expect(listener.mock.calls.at(-1)?.[0]).not.toHaveProperty('alpha_malformed');
    await manager.disconnectAll();
  });

  it('clears the registry while a replacement connects, then publishes only the replacement', async () => {
    const { manager, responses } = harness();
    const alpha = config('alpha');
    const beta = config('beta');
    const betaConnect = deferred<MCPClientStatus>();
    responses.set(alpha.mcpServers.alpha.url, connectedStatus('alpha'));
    responses.set(beta.mcpServers.beta.url, betaConnect);
    const registry = new ToolRegistryManager(manager);
    await registry.loadRemoteTools(storageConfig(alpha));
    const oldSnapshot = registry.captureToolSnapshot(1);

    const replacement = registry.loadRemoteTools(storageConfig(beta));

    expect(oldSnapshot.remoteSession.signal.aborted).toBe(true);
    expect(registry.captureToolSnapshot(1).tools).not.toHaveProperty('alpha_search');
    expect(registry.captureToolSnapshot(1).remoteSession).toBe(EMPTY_REMOTE_MCP_SESSION);

    betaConnect.resolve(connectedStatus('beta'));
    await replacement;
    const nextSnapshot = registry.captureToolSnapshot(1);
    expect(nextSnapshot.tools).toHaveProperty('beta_search');
    expect(nextSnapshot.tools).not.toHaveProperty('alpha_search');
    expect(nextSnapshot.mcpInstructions).toContain('beta instructions');
    await manager.disconnectAll();
  });

  it('does not signal tab-scoped page-tool changes when the first remote session appears', async () => {
    const { manager, responses } = harness();
    const alpha = config('alpha');
    responses.set(alpha.mcpServers.alpha.url, connectedStatus('alpha'));
    const registry = new ToolRegistryManager(manager);
    const tabToolsChanged = vi.fn();
    registry.onTabToolsChanged(7, tabToolsChanged);

    await registry.loadRemoteTools(storageConfig(alpha));

    expect(tabToolsChanged).not.toHaveBeenCalled();
    expect(registry.captureToolSnapshot(7).tools).toHaveProperty('alpha_search');
    await manager.disconnectAll();
  });

  it('force revocation clears remote tools but leaves tab-scoped page tools intact', async () => {
    const { manager, responses } = harness();
    const alpha = config('alpha');
    responses.set(alpha.mcpServers.alpha.url, connectedStatus('alpha'));
    const registry = new ToolRegistryManager(manager);
    registry.addTool('page_tool', {
      tool: { execute: vi.fn() },
      source: 'site',
      origin: 'tab-5',
    });
    await registry.loadRemoteTools(storageConfig(alpha));

    registry.revokeRemoteTools();

    const snapshot = registry.captureToolSnapshot(5);
    expect(snapshot.tools).toHaveProperty('page_tool');
    expect(snapshot.tools).not.toHaveProperty('alpha_search');
    expect(snapshot.remoteSession).toBe(EMPTY_REMOTE_MCP_SESSION);
    await manager.disconnectAll();
  });
});
