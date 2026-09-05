import { beforeEach, describe, expect, it } from 'vitest';
import {
  fingerprintToolSet,
  recordToolSet,
  resetToolSetTracking,
  summarizeCacheUsage,
} from '../src/lib/ai/prompt-cache-telemetry';

const tool = (description: string, schema: unknown = { type: 'object' }) => ({
  description,
  inputSchema: { jsonSchema: schema, validate: () => true },
  execute: async () => 'result',
});

describe('tool set fingerprint', () => {
  it('is stable across calls when nothing about the tools changed', () => {
    const build = () => ({ read_page: tool('Reads'), navigate: tool('Navigates') });

    expect(fingerprintToolSet(build()).hash).toBe(fingerprintToolSet(build()).hash);
  });

  it('ignores execute, which never reaches the provider and cannot affect a cache key', () => {
    const withOneBody = { read_page: { ...tool('Reads'), execute: async () => 'a' } };
    const withAnother = { read_page: { ...tool('Reads'), execute: async () => 'bbbbb' } };

    expect(fingerprintToolSet(withOneBody).hash).toBe(fingerprintToolSet(withAnother).hash);
  });

  it('separates a description change from an identical tool set', () => {
    const before = fingerprintToolSet({ read_page: tool('Reads') });
    const after = fingerprintToolSet({ read_page: tool('Reads the page') });

    expect(after.hash).not.toBe(before.hash);
  });

  it('separates a schema change, which is what MCP drift looks like', () => {
    const before = fingerprintToolSet({ search: tool('Search', { enum: ['a'] }) });
    const after = fingerprintToolSet({ search: tool('Search', { enum: ['a', 'b'] }) });

    expect(after.hash).not.toBe(before.hash);
  });

  it('treats reordering as a different prefix, because the provider does', () => {
    const before = fingerprintToolSet({ a: tool('A'), b: tool('B') });
    const after = fingerprintToolSet({ b: tool('B'), a: tool('A') });

    expect(after.hash).not.toBe(before.hash);
    expect(after.names).toEqual(['b', 'a']);
  });

  it('survives a tool whose schema cannot be serialized', () => {
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.self = cyclic;

    expect(() => fingerprintToolSet({ odd: tool('Odd', cyclic) })).not.toThrow();
  });
});

describe('tool set churn', () => {
  beforeEach(resetToolSetTracking);

  it('reports no comparison on the first request of a worker lifetime', () => {
    // A false "unchanged" would be read as evidence of stability, so the field is absent.
    expect(recordToolSet({ a: tool('A') })).not.toHaveProperty('changedSincePreviousRequest');
  });

  it('reports an unchanged tool set between two identical requests', () => {
    recordToolSet({ a: tool('A') });

    expect(recordToolSet({ a: tool('A') })).toMatchObject({ changedSincePreviousRequest: false });
  });

  it('names what a navigation added and retracted', () => {
    recordToolSet({ read_page: tool('Reads'), site_checkout: tool('Checks out') });

    expect(
      recordToolSet({ read_page: tool('Reads'), site_search: tool('Searches') })
    ).toMatchObject({
      changedSincePreviousRequest: true,
      added: ['site_search'],
      removed: ['site_checkout'],
    });
  });

  it('flags reordering separately, since it costs a cache miss and is never required', () => {
    recordToolSet({ a: tool('A'), b: tool('B') });
    const change = recordToolSet({ b: tool('B'), a: tool('A') });

    expect(change).toMatchObject({ changedSincePreviousRequest: true, reordered: true });
    expect(change).not.toHaveProperty('added');
  });

  it('flags a redefinition when membership and order both held', () => {
    // This is the late-arriving-MCP-schema case: same names, different bytes.
    recordToolSet({ search: tool('Search', { enum: ['a'] }) });

    expect(recordToolSet({ search: tool('Search', { enum: ['a', 'b'] }) })).toMatchObject({
      changedSincePreviousRequest: true,
      redefined: true,
    });
  });
});

describe('cache usage summary', () => {
  it('computes a hit rate the log can be read for directly', () => {
    expect(summarizeCacheUsage({ inputTokens: 10_000, cachedInputTokens: 9_000 })).toEqual({
      inputTokens: 10_000,
      cachedInputTokens: 9_000,
      cacheHitPercent: 90,
      cacheReported: true,
    });
  });

  it('distinguishes a reported zero from a provider that reports nothing', () => {
    expect(summarizeCacheUsage({ inputTokens: 500, cachedInputTokens: 0 })).toMatchObject({
      cacheHitPercent: 0,
      cacheReported: true,
    });
    expect(summarizeCacheUsage({ inputTokens: 500 })).toMatchObject({ cacheReported: false });
  });

  it('does not divide by zero on an empty prompt', () => {
    expect(summarizeCacheUsage({ inputTokens: 0, cachedInputTokens: 0 })).not.toHaveProperty(
      'cacheHitPercent'
    );
  });

  it('tolerates a finish event with no usage at all', () => {
    expect(summarizeCacheUsage(undefined)).toEqual({ cacheReported: false });
  });
});
