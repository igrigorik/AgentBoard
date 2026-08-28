/**
 * Persisted remote MCP tool catalog.
 *
 * The catalog is a *hint* used to build the model's tool list. It is never an
 * authority: execution re-resolves every cached tool against the server's live
 * advertised list and fails closed, so a stale catalog can only affect what the
 * model knows exists, never what it is allowed to call.
 *
 * It lives in chrome.storage.session because the service worker dies after ~30s
 * idle while stream start blocks on tool readiness. Worker-memory caching would
 * therefore put an MCP handshake on the critical path of most messages. Session
 * storage is browser-session scoped, memory-only, and TRUSTED_CONTEXTS by
 * default, so content scripts cannot read it.
 *
 * Only the service worker realm writes this key. The Options page has its own
 * RemoteMCPManager but only ever calls probe(), which is isolated by design.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { MCPConfig } from '../storage/config';

const CATALOG_KEY = 'mcpToolCatalog';

/** Refresh cadence for a catalog that has tools. A throttle, never an expiry: being
 *  past it permits a background refresh, it never makes the cache unusable. */
export const CATALOG_REFRESH_THROTTLE_MS = 60 * 60_000;

/** Retry delay for a catalog that discovered nothing, so one transient outage does
 *  not negatively cache for the whole browser session. */
export const CATALOG_FAILURE_COOLDOWN_MS = 60_000;

export interface RemoteToolCatalog {
  /** The exact config this catalog was discovered under. The cache outlives the
   *  process that knew this, so materialization must re-verify it. */
  mcpConfig: MCPConfig;
  capabilities: Array<{ serverName: string; tool: Tool }>;
  /** Server instructions feed the system prompt; caching tools alone would drop them. */
  instructions: Record<string, string>;
  discoveredAt: number;
}

function sessionStorage(): chrome.storage.StorageArea | null {
  return globalThis.chrome?.storage?.session ?? null;
}

function isCatalog(value: unknown): value is RemoteToolCatalog {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RemoteToolCatalog>;
  return (
    !!candidate.mcpConfig &&
    typeof candidate.mcpConfig === 'object' &&
    Array.isArray(candidate.capabilities) &&
    !!candidate.instructions &&
    typeof candidate.instructions === 'object' &&
    typeof candidate.discoveredAt === 'number' &&
    Number.isFinite(candidate.discoveredAt)
  );
}

export async function readCatalog(): Promise<RemoteToolCatalog | null> {
  const storage = sessionStorage();
  if (!storage) return null;
  try {
    const stored = await storage.get(CATALOG_KEY);
    const value = stored?.[CATALOG_KEY];
    return isCatalog(value) ? value : null;
  } catch {
    // A cache read must never be able to break tool loading.
    return null;
  }
}

export async function writeCatalog(catalog: RemoteToolCatalog): Promise<void> {
  const storage = sessionStorage();
  if (!storage) return;
  try {
    await storage.set({ [CATALOG_KEY]: catalog });
  } catch {
    // Best-effort: losing the cache costs latency, never correctness.
  }
}

export async function clearCatalog(): Promise<void> {
  const storage = sessionStorage();
  if (!storage) return;
  try {
    await storage.remove(CATALOG_KEY);
  } catch {
    // Best-effort; a surviving stale catalog is re-verified against config on read.
  }
}

/**
 * Age of a catalog, tolerant of a backwards system-clock correction: a future
 * timestamp would otherwise pin the cache as permanently fresh.
 */
export function catalogAgeMs(catalog: RemoteToolCatalog, now = Date.now()): number {
  return Math.abs(now - catalog.discoveredAt);
}
