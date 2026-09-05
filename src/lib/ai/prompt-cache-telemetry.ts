/**
 * Diagnostics for provider prompt caching.
 *
 * OpenAI and Gemini cache prompt prefixes automatically, with no configuration, and bill
 * cached input at a fraction of the normal rate. Both key the cache on a byte-identical
 * prefix, and every provider serializes the prompt as tools, then system, then messages.
 * That ordering is the whole reason this module watches the tool set rather than the
 * conversation: a change to the tool array shifts the very first bytes of the prompt, so it
 * invalidates everything behind it, while a change to the newest message costs nothing that
 * was not already going to be uncached.
 *
 * Some tool churn is semantic and unavoidable -- leaving a page must retract the tools that
 * page offered. Churn with no navigation behind it is not, and from the outside the two are
 * indistinguishable, which is why the fingerprint records the shape of each change instead
 * of only whether one happened.
 *
 * This module measures. It deliberately changes no behavior, because the cost of the churn
 * it is meant to find has never been observed, only argued about.
 */

import type { LanguageModelUsage } from 'ai';

/** Identity of one tool set, as the provider will see it in the prompt prefix. */
export interface ToolSetPrint {
  /** Digest over each tool's name, description, and input schema, in prompt order. */
  hash: string;
  /** Public tool names, in the order they are serialized. */
  names: readonly string[];
}

export interface ToolSetChange extends ToolSetPrint {
  /** Absent for the first request of a worker lifetime, where no comparison is possible. */
  changedSincePreviousRequest?: boolean;
  added?: readonly string[];
  removed?: readonly string[];
  /** Same membership in a different order. Still a cache miss, and never semantically required. */
  reordered?: boolean;
  /** Same membership and order, but some description or schema differs. Also a full miss. */
  redefined?: boolean;
}

/**
 * FNV-1a over the serialized tool definitions. Not cryptographic, and does not need to be:
 * this compares a value against its own previous self within one worker, where the only
 * adversary is coincidence. Chosen over SubtleCrypto because that is async and this sits on
 * the hot path of assembling a request.
 */
function digest(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Serialize the parts of a tool the provider actually receives. `execute` is deliberately
 * excluded: it never crosses the wire, so a change to it cannot affect a cache key. The AI
 * SDK's `jsonSchema()` helper wraps the schema alongside a validator, so the raw schema is
 * unwrapped when present rather than stringifying the wrapper's incidental fields.
 */
function serializeTool(name: string, tool: unknown): string {
  const record = (tool ?? {}) as Record<string, unknown>;
  const schemaHolder = record.inputSchema as Record<string, unknown> | undefined;
  const schema = schemaHolder?.jsonSchema ?? schemaHolder;
  let serializedSchema: string;
  try {
    serializedSchema = JSON.stringify(schema) ?? 'undefined';
  } catch {
    // A schema carrying a cycle cannot be sent to a provider either, so its exact shape does
    // not matter here; what matters is that fingerprinting never breaks a chat request.
    serializedSchema = 'unserializable';
  }
  return `${name}\u0000${String(record.description ?? '')}\u0000${serializedSchema}`;
}

export function fingerprintToolSet(tools: Record<string, unknown>): ToolSetPrint {
  // Object key order is the prompt order, so it is preserved rather than sorted away.
  const names = Object.keys(tools);
  return {
    hash: digest(names.map((name) => serializeTool(name, tools[name])).join('\u0001')),
    names,
  };
}

/**
 * Module-level rather than per-conversation because the question being asked is about the
 * provider's cache, which is keyed on the request and not on our notion of a session. The
 * state dies with the MV3 worker, so the first request after every wake reports no
 * comparison; that is honest, and a false "unchanged" would be worse than a gap.
 */
let previousPrint: ToolSetPrint | undefined;

export function recordToolSet(tools: Record<string, unknown>): ToolSetChange {
  const print = fingerprintToolSet(tools);
  const previous = previousPrint;
  previousPrint = print;

  if (!previous) return print;
  if (previous.hash === print.hash) return { ...print, changedSincePreviousRequest: false };

  const before = new Set(previous.names);
  const after = new Set(print.names);
  const added = print.names.filter((name) => !before.has(name));
  const removed = previous.names.filter((name) => !after.has(name));
  const sameMembership = added.length === 0 && removed.length === 0;
  const reordered = sameMembership && previous.names.join() !== print.names.join();

  return {
    ...print,
    changedSincePreviousRequest: true,
    ...(added.length > 0 && { added }),
    ...(removed.length > 0 && { removed }),
    ...(reordered && { reordered: true }),
    // Membership and order both held, so the difference is inside a description or schema.
    ...(sameMembership && !reordered && { redefined: true }),
  };
}

/** Reset between tests; the worker has no reason to call this. */
export function resetToolSetTracking(): void {
  previousPrint = undefined;
}

export interface CacheUsageSummary {
  inputTokens?: number;
  cachedInputTokens?: number;
  /** Share of input tokens served from cache, rounded to whole percent. */
  cacheHitPercent?: number;
  /**
   * Absent when the provider reports no cache field at all, which is the expected reading
   * for Anthropic today because no cache_control breakpoints are set anywhere.
   */
  cacheReported: boolean;
}

export function summarizeCacheUsage(
  usage: Partial<LanguageModelUsage> | undefined
): CacheUsageSummary {
  const inputTokens = typeof usage?.inputTokens === 'number' ? usage.inputTokens : undefined;
  const cachedInputTokens =
    typeof usage?.cachedInputTokens === 'number' ? usage.cachedInputTokens : undefined;

  return {
    ...(inputTokens !== undefined && { inputTokens }),
    ...(cachedInputTokens !== undefined && { cachedInputTokens }),
    ...(inputTokens !== undefined &&
      cachedInputTokens !== undefined &&
      inputTokens > 0 && { cacheHitPercent: Math.round((cachedInputTokens / inputTokens) * 100) }),
    cacheReported: cachedInputTokens !== undefined,
  };
}
