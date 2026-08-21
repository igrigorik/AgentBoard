/**
 * Persistent backoff for MCP servers that reject our credential.
 *
 * The MV3 service worker restarts frequently and re-runs remote MCP
 * reconciliation on every wake. In-memory state does not survive those
 * restarts, so a server that answers 401/403 (expired token, missing
 * upstream credential) would otherwise be re-attempted forever at the
 * worker restart cadence — hammering the remote endpoint around the clock.
 *
 * State lives in chrome.storage.session: it survives worker restarts but is
 * cleared when the browser closes, so a stale backoff can never outlive the
 * browsing session. Entries are keyed by server URL plus a hash of the auth
 * token, so editing either retries immediately. Storage problems fail open:
 * backoff is an optimization, never a gate that can wedge connectivity.
 */

import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import log from '../logger';
import type { MCPServerConfig } from '../storage/config';

export const AUTH_BACKOFF_BASE_MS = 60_000;
export const AUTH_BACKOFF_MAX_MS = 30 * 60_000;

/** Entries idle this long are dropped on the next write. */
const PRUNE_AFTER_MS = 24 * 60 * 60_000;

const STORAGE_KEY = 'mcpAuthBackoff';

export interface AuthBackoffEntry {
  failures: number;
  nextAttemptAt: number;
}

type AuthBackoffTable = Record<string, AuthBackoffEntry>;

/** HTTP 401/403 from the transport; anything else keeps normal retry behavior. */
export function isAuthError(error: unknown): boolean {
  return error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403);
}

export function authBackoffDelayMs(failures: number): number {
  const doublings = Math.min(Math.max(failures, 1) - 1, 30);
  return Math.min(AUTH_BACKOFF_BASE_MS * 2 ** doublings, AUTH_BACKOFF_MAX_MS);
}

/**
 * The token participates only as a hash: backoff keys are written to
 * extension storage and must not persist the credential itself.
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function backoffKey(config: MCPServerConfig): string {
  return `${config.url}#${fnv1a(config.authToken ?? '')}`;
}

function storageArea(): chrome.storage.StorageArea | null {
  if (typeof chrome === 'undefined' || !chrome.storage) return null;
  return chrome.storage.session ?? null;
}

async function readTable(): Promise<AuthBackoffTable> {
  const area = storageArea();
  if (!area) return {};
  try {
    const stored = await area.get(STORAGE_KEY);
    const table = stored[STORAGE_KEY];
    return table && typeof table === 'object' ? (table as AuthBackoffTable) : {};
  } catch {
    log.warn('[MCPAuthBackoff] Failed to read backoff state');
    return {};
  }
}

async function writeTable(table: AuthBackoffTable, now: number): Promise<void> {
  const area = storageArea();
  if (!area) return;
  const pruned: AuthBackoffTable = {};
  for (const [key, entry] of Object.entries(table)) {
    if (entry.nextAttemptAt > now - PRUNE_AFTER_MS) pruned[key] = entry;
  }
  try {
    await area.set({ [STORAGE_KEY]: pruned });
  } catch {
    log.warn('[MCPAuthBackoff] Failed to persist backoff state');
  }
}

/** Returns the entry only while its retry window is still in the future. */
export async function getActiveAuthBackoff(
  config: MCPServerConfig
): Promise<AuthBackoffEntry | null> {
  const entry = (await readTable())[backoffKey(config)];
  if (!entry || entry.nextAttemptAt <= Date.now()) return null;
  return entry;
}

export async function recordAuthFailure(config: MCPServerConfig): Promise<AuthBackoffEntry> {
  const now = Date.now();
  const table = await readTable();
  const key = backoffKey(config);
  const failures = (table[key]?.failures ?? 0) + 1;
  const entry: AuthBackoffEntry = {
    failures,
    nextAttemptAt: now + authBackoffDelayMs(failures),
  };
  table[key] = entry;
  await writeTable(table, now);
  return entry;
}

export async function clearAuthBackoff(config: MCPServerConfig): Promise<void> {
  const table = await readTable();
  const key = backoffKey(config);
  if (!(key in table)) return;
  delete table[key];
  await writeTable(table, Date.now());
}
