/**
 * Remote MCP catalog caching.
 *
 * The catalog is a hint: it makes tools available without contacting servers on a
 * cold worker. Authority stays with the live connection, which is re-resolved at
 * execution. These tests pin the invariants that make that split safe.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPClientService, MCPClientStatus } from '../src/lib/mcp/client';
import {
  CATALOG_FAILURE_COOLDOWN_MS,
  CATALOG_REFRESH_THROTTLE_MS,
  type RemoteToolCatalog,
} from '../src/lib/mcp/catalog';
import { RemoteMCPManager } from '../src/lib/mcp/manager';
import type { MCPConfig, MCPServerConfig } from '../src/lib/storage/config';

const CATALOG_KEY = 'mcpToolCatalog';

function config(name: string): MCPConfig {
  return { mcpServers: { [name]: { transport: 'http', url: `https://${name}.example.test/mcp` } } };
}

function tool(name: string, schema: Record<string, unknown> = {}) {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object' as const, ...schema },
  };
}

function catalog(serverName: string, tools = [tool('search')], ageMs = 0): RemoteToolCatalog {
  return {
    mcpConfig: config(serverName),
    capabilities: tools.map((entry) => ({ serverName, tool: entry })),
    instructions: { [serverName]: `${serverName} instructions` },
    discoveredAt: Date.now() - ageMs,
  };
}

function installSessionStorage(seed?: RemoteToolCatalog) {
  const store = new Map<string, unknown>();
  if (seed) store.set(CATALOG_KEY, seed);
  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: vi.fn(async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value);
        }),
        remove: vi.fn(async (key: string) => void store.delete(key)),
      },
    },
  });
  return store;
}

class FakeClient {
  connected = false;
  readonly disconnect = vi.fn(async () => void (this.connected = false));
  readonly callTool = vi.fn(async () => ({
    isError: false,
    content: [{ type: 'text' as const, text: 'ok' }],
  }));

  constructor(
    private readonly connectResult: (serverConfig: MCPServerConfig) => Promise<MCPClientStatus>
  ) {}

  async connect(serverConfig: MCPServerConfig): Promise<MCPClientStatus> {
    const status = await this.connectResult(serverConfig);
    this.connected = status.connected;
    return status;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

function harness(respond: (url: string) => Promise<MCPClientStatus> | MCPClientStatus) {
  const clients: FakeClient[] = [];
  const manager = new RemoteMCPManager(() => {
    const client = new FakeClient(async (serverConfig) => respond(serverConfig.url));
    clients.push(client);
    return client as unknown as MCPClientService;
  });
  return { manager, clients };
}

function connected(serverName: string, tools = [tool('search')]): MCPClientStatus {
  return { connected: true, serverName, tools, instructions: `${serverName} instructions` };
}

describe('remote MCP catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('serves a cached catalog without contacting any server', async () => {
    installSessionStorage(catalog('alpha'));
    const { manager, clients } = harness(() => connected('alpha'));

    await manager.ensure(config('alpha'));

    expect(clients).toHaveLength(0);
    const session = manager.getCurrentSession();
    expect(session.getToolCapabilities().map(({ tool: entry }) => entry.name)).toEqual(['search']);
    // hasContext must stay true or a stream never attaches its revocation listener.
    expect(session.hasContext).toBe(true);
    expect(session.getMCPInstructions()).toContain('alpha instructions');
  });

  it('never materializes a catalog discovered under a different config', async () => {
    installSessionStorage(catalog('alpha'));
    const requested: string[] = [];
    const { manager } = harness((url) => {
      requested.push(url);
      return connected('beta', [tool('lookup')]);
    });

    await manager.ensure(config('beta'));

    expect(requested).toEqual(['https://beta.example.test/mcp']);
    expect(
      manager
        .getCurrentSession()
        .getToolCapabilities()
        .map(({ tool: e }) => e.name)
    ).toEqual(['lookup']);
  });

  it('does not abort a live session when a stale catalog refreshes behind it', async () => {
    const store = installSessionStorage(
      catalog('alpha', [tool('search')], CATALOG_REFRESH_THROTTLE_MS + 1_000)
    );
    const { manager } = harness(() => connected('alpha', [tool('search'), tool('added')]));

    await manager.ensure(config('alpha'));
    const session = manager.getCurrentSession();
    const aborted = vi.fn();
    session.signal.addEventListener('abort', aborted);

    // Wait for the refresh to have *fully settled* -- observing that it started is not
    // enough, because publishing would happen after the write it is waiting on.
    await vi.waitFor(() =>
      expect((store.get(CATALOG_KEY) as RemoteToolCatalog).capabilities).toHaveLength(2)
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A hint update must never revoke authority a stream is holding.
    expect(aborted).not.toHaveBeenCalled();
    expect(session.signal.aborted).toBe(false);
    expect(manager.getCurrentSession()).toBe(session);
  });

  it('detaches stale authority synchronously, before reading the cache', async () => {
    installSessionStorage(catalog('beta'));
    const { manager } = harness(() => connected('alpha'));
    await manager.ensure(config('alpha'));
    const stale = manager.getCurrentSession();

    // Deliberately not awaited: the revoke must happen before ensure()'s first await,
    // or a snapshot taken right now could still capture replaced configuration.
    void manager.ensure(config('beta'));

    expect(stale.signal.aborted).toBe(true);
    expect(manager.getCurrentSession().hasContext).toBe(false);
  });

  it('connects once when parallel calls hit the same cached server', async () => {
    installSessionStorage(catalog('alpha'));
    const { manager, clients } = harness(() => connected('alpha'));
    await manager.ensure(config('alpha'));
    const session = manager.getCurrentSession();
    const [capability] = session.getToolCapabilities();

    await Promise.all([
      session.executeTool(capability, {}),
      session.executeTool(capability, {}),
      session.executeTool(capability, {}),
    ]);

    expect(clients).toHaveLength(1);
    expect(clients[0].callTool).toHaveBeenCalledTimes(3);
  });

  it('refuses a cached tool the server no longer advertises', async () => {
    installSessionStorage(catalog('alpha', [tool('search')]));
    const { manager, clients } = harness(() => connected('alpha', [tool('somethingElse')]));
    await manager.ensure(config('alpha'));
    const [capability] = manager.getCurrentSession().getToolCapabilities();

    await expect(manager.getCurrentSession().executeTool(capability, {})).rejects.toThrow(
      /no longer available/
    );
    expect(clients[0].callTool).not.toHaveBeenCalled();
  });

  it('refuses a cached tool whose input schema moved', async () => {
    installSessionStorage(catalog('alpha', [tool('search', { required: ['q'] })]));
    const { manager, clients } = harness(() =>
      connected('alpha', [tool('search', { required: ['query'] })])
    );
    await manager.ensure(config('alpha'));
    const [capability] = manager.getCurrentSession().getToolCapabilities();

    // The model generated arguments against the cached schema; sending them would be
    // grounded in a contract the server no longer honors.
    await expect(manager.getCurrentSession().executeTool(capability, {})).rejects.toThrow(
      /changed its input schema/
    );
    expect(clients[0].callTool).not.toHaveBeenCalled();
  });

  it('revokes before calling when authority is lost during the lazy connect', async () => {
    installSessionStorage(catalog('alpha'));
    let releaseConnect!: (status: MCPClientStatus) => void;
    const { manager, clients } = harness(
      () =>
        new Promise<MCPClientStatus>((resolve) => {
          releaseConnect = resolve;
        })
    );
    await manager.ensure(config('alpha'));
    const session = manager.getCurrentSession();
    const [capability] = session.getToolCapabilities();

    const execution = session.executeTool(capability, {});
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    manager.revoke();
    releaseConnect(connected('alpha'));

    await expect(execution).rejects.toThrow(/Aborted/);
    expect(clients[0].callTool).not.toHaveBeenCalled();
  });

  it('negatively caches a failed discovery, then retries after the cooldown', async () => {
    const store = installSessionStorage();
    const failing = { connected: false, serverName: 'alpha', error: 'Connection failed' };
    const first = harness(() => failing);
    await first.manager.ensure(config('alpha'));
    expect(first.clients).toHaveLength(1);

    const cached = store.get(CATALOG_KEY) as RemoteToolCatalog;
    expect(cached.capabilities).toEqual([]);

    // A new worker within the cooldown must serve the empty catalog, not re-block.
    const second = harness(() => failing);
    await second.manager.ensure(config('alpha'));
    expect(second.clients).toHaveLength(0);

    store.set(CATALOG_KEY, { ...cached, discoveredAt: Date.now() - CATALOG_FAILURE_COOLDOWN_MS });
    const third = harness(() => connected('alpha'));
    await third.manager.ensure(config('alpha'));
    expect(third.clients).toHaveLength(1);
    expect(third.manager.getCurrentSession().getToolCapabilities()).toHaveLength(1);
  });

  it('keeps the last good catalog when a background refresh finds nothing', async () => {
    const store = installSessionStorage(
      catalog('alpha', [tool('search')], CATALOG_REFRESH_THROTTLE_MS + 1_000)
    );
    let attempted = false;
    const { manager } = harness(() => {
      attempted = true;
      return { connected: false, serverName: 'alpha', error: 'Connection failed' };
    });

    await manager.ensure(config('alpha'));
    await vi.waitFor(() => expect(attempted).toBe(true));
    await Promise.resolve();

    const stored = store.get(CATALOG_KEY) as RemoteToolCatalog;
    expect(stored.capabilities).toHaveLength(1);
  });

  it('discards the cache on an explicit forced refresh', async () => {
    const store = installSessionStorage(catalog('alpha', [tool('search')]));
    const { manager, clients } = harness(() => connected('alpha', [tool('refreshed')]));

    await manager.forceRefresh(config('alpha'));

    expect(clients).toHaveLength(1);
    expect(
      manager
        .getCurrentSession()
        .getToolCapabilities()
        .map(({ tool: e }) => e.name)
    ).toEqual(['refreshed']);
    expect((store.get(CATALOG_KEY) as RemoteToolCatalog).capabilities).toHaveLength(1);
  });
});
