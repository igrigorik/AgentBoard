/**
 * Auth-failure backoff for remote MCP connections.
 *
 * The MV3 service worker restarts constantly and re-runs remote MCP
 * reconciliation on every wake. Without persistent memory, a server that
 * rejects our credential (HTTP 401/403) is retried forever at the worker
 * restart cadence. These tests pin the contract: auth failures back off
 * exponentially across worker restarts, credential edits retry immediately,
 * and non-auth failures keep the existing retry behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  isAuthError,
  authBackoffDelayMs,
  getActiveAuthBackoff,
  recordAuthFailure,
  clearAuthBackoff,
  AUTH_BACKOFF_BASE_MS,
  AUTH_BACKOFF_MAX_MS,
} from '../src/lib/mcp/auth-backoff';
import { MCPClientService } from '../src/lib/mcp/client';
import type { MCPServerConfig } from '../src/lib/storage/config';

const mockClientConnect = vi.fn();
const mockListTools = vi.fn();
const mockGetInstructions = vi.fn();
const mockClose = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mockClientConnect;
    listTools = mockListTools;
    getInstructions = mockGetInstructions;
    close = mockClose;
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js')>();
  return {
    ...actual,
    StreamableHTTPClientTransport: class {
      constructor(
        public url: URL,
        public opts: unknown
      ) {}
    },
  };
});

vi.mock('@modelcontextprotocol/sdk/validation/cfworker', () => ({
  CfWorkerJsonSchemaValidator: class {},
}));

function installSessionStorage(): void {
  let store: Record<string, unknown> = {};
  (chrome.storage as unknown as Record<string, unknown>).session = {
    get: vi.fn(async (keys?: string | string[]) => {
      if (keys === undefined) return { ...store };
      const wanted = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of wanted) {
        if (key in store) result[key] = structuredClone(store[key]);
      }
      return result;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      store = { ...store, ...structuredClone(items) };
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete store[key];
      }
    }),
  };
}

function serverConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    transport: 'http',
    url: 'https://mcp.example.test/mcp',
    authToken: 'token-a',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  installSessionStorage();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isAuthError', () => {
  it('recognizes HTTP 401 and 403 transport errors', () => {
    expect(isAuthError(new StreamableHTTPError(401, 'Unauthorized'))).toBe(true);
    expect(isAuthError(new StreamableHTTPError(403, 'Forbidden'))).toBe(true);
  });

  it('ignores other transport errors and generic failures', () => {
    expect(isAuthError(new StreamableHTTPError(500, 'boom'))).toBe(false);
    expect(isAuthError(new StreamableHTTPError(-1, 'bad content type'))).toBe(false);
    expect(isAuthError(new Error('network down'))).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });
});

describe('authBackoffDelayMs', () => {
  it('doubles per consecutive failure and caps at the maximum', () => {
    expect(authBackoffDelayMs(1)).toBe(AUTH_BACKOFF_BASE_MS);
    expect(authBackoffDelayMs(2)).toBe(AUTH_BACKOFF_BASE_MS * 2);
    expect(authBackoffDelayMs(3)).toBe(AUTH_BACKOFF_BASE_MS * 4);
    expect(authBackoffDelayMs(100)).toBe(AUTH_BACKOFF_MAX_MS);
  });
});

describe('backoff store', () => {
  it('activates after a recorded failure and expires with time', async () => {
    const config = serverConfig();
    expect(await getActiveAuthBackoff(config)).toBeNull();

    await recordAuthFailure(config);
    const entry = await getActiveAuthBackoff(config);
    expect(entry).not.toBeNull();
    expect(entry!.failures).toBe(1);
    expect(entry!.nextAttemptAt).toBe(Date.now() + AUTH_BACKOFF_BASE_MS);

    vi.advanceTimersByTime(AUTH_BACKOFF_BASE_MS + 1);
    expect(await getActiveAuthBackoff(config)).toBeNull();
  });

  it('escalates consecutive failures and resets on clear', async () => {
    const config = serverConfig();
    await recordAuthFailure(config);
    await recordAuthFailure(config);
    const entry = await getActiveAuthBackoff(config);
    expect(entry!.failures).toBe(2);
    expect(entry!.nextAttemptAt).toBe(Date.now() + AUTH_BACKOFF_BASE_MS * 2);

    await clearAuthBackoff(config);
    expect(await getActiveAuthBackoff(config)).toBeNull();
    await recordAuthFailure(config);
    expect((await getActiveAuthBackoff(config))!.failures).toBe(1);
  });

  it('keys backoff by credential so URL or token edits retry immediately', async () => {
    await recordAuthFailure(serverConfig());
    expect(await getActiveAuthBackoff(serverConfig({ authToken: 'token-b' }))).toBeNull();
    expect(
      await getActiveAuthBackoff(serverConfig({ url: 'https://other.example.test/mcp' }))
    ).toBeNull();
  });

  it('fails open when session storage is unavailable', async () => {
    delete (chrome.storage as unknown as Record<string, unknown>).session;
    const config = serverConfig();
    await expect(recordAuthFailure(config)).resolves.toBeDefined();
    expect(await getActiveAuthBackoff(config)).toBeNull();
  });
});

describe('MCPClientService auth backoff integration', () => {
  it('records a backoff on 401 and skips the next connection attempt', async () => {
    mockClientConnect.mockRejectedValue(new StreamableHTTPError(401, 'Unauthorized'));

    const first = await new MCPClientService().connect(serverConfig(), 'remote');
    expect(first.connected).toBe(false);
    expect(first.error).toMatch(/authentication/i);
    expect(mockClientConnect).toHaveBeenCalledTimes(1);

    const second = await new MCPClientService().connect(serverConfig(), 'remote');
    expect(second.connected).toBe(false);
    expect(second.error).toMatch(/authentication/i);
    // Still in the backoff window: no new network attempt.
    expect(mockClientConnect).toHaveBeenCalledTimes(1);
  });

  it('retries after the backoff window elapses', async () => {
    mockClientConnect.mockRejectedValue(new StreamableHTTPError(401, 'Unauthorized'));
    await new MCPClientService().connect(serverConfig(), 'remote');

    vi.advanceTimersByTime(AUTH_BACKOFF_BASE_MS + 1);
    await new MCPClientService().connect(serverConfig(), 'remote');
    expect(mockClientConnect).toHaveBeenCalledTimes(2);

    // Second consecutive failure doubles the window.
    const entry = await getActiveAuthBackoff(serverConfig());
    expect(entry!.failures).toBe(2);
    expect(entry!.nextAttemptAt).toBe(Date.now() + AUTH_BACKOFF_BASE_MS * 2);
  });

  it('does not back off on non-auth failures', async () => {
    mockClientConnect.mockRejectedValue(new Error('network down'));

    await new MCPClientService().connect(serverConfig(), 'remote');
    await new MCPClientService().connect(serverConfig(), 'remote');
    expect(mockClientConnect).toHaveBeenCalledTimes(2);
    expect(await getActiveAuthBackoff(serverConfig())).toBeNull();
  });

  it('clears the backoff after a successful connection', async () => {
    mockClientConnect.mockRejectedValueOnce(new StreamableHTTPError(401, 'Unauthorized'));
    mockClientConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockGetInstructions.mockReturnValue(undefined);

    await new MCPClientService().connect(serverConfig(), 'remote');
    vi.advanceTimersByTime(AUTH_BACKOFF_BASE_MS + 1);

    const result = await new MCPClientService().connect(serverConfig(), 'remote');
    expect(result.connected).toBe(true);
    expect(await getActiveAuthBackoff(serverConfig())).toBeNull();
  });

  it('retries immediately when the auth token changes', async () => {
    mockClientConnect.mockRejectedValue(new StreamableHTTPError(401, 'Unauthorized'));
    await new MCPClientService().connect(serverConfig(), 'remote');

    await new MCPClientService().connect(serverConfig({ authToken: 'token-b' }), 'remote');
    expect(mockClientConnect).toHaveBeenCalledTimes(2);
  });
});
