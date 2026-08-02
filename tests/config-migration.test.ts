import { describe, expect, it, vi } from 'vitest';
import { migrateAgentToV2 } from '../src/lib/storage/config-migration';

type LegacyAgent = Record<string, unknown>;

function legacy(overrides: LegacyAgent = {}): LegacyAgent {
  return {
    id: 'agent-1',
    name: 'Agent',
    provider: 'openai',
    model: 'model',
    temperature: 0.7,
    maxTokens: 1000,
    ...overrides,
  };
}

describe('migrateAgentToV2', () => {
  it.each([
    [{ openaiCompatible: true }, 'openai-responses'],
    [{ openaiCompatible: false }, 'openai-responses'],
    [{ provider: 'anthropic', openaiCompatible: true }, 'anthropic-messages'],
    [{ provider: 'anthropic', openaiCompatible: false }, 'anthropic-messages'],
    [{ provider: 'google', openaiCompatible: true }, 'google-generative-ai'],
    [{ provider: 'google', openaiCompatible: false }, 'google-generative-ai'],
    [{ endpoint: '', openaiCompatible: true }, 'openai-responses'],
    [{ provider: 'anthropic', endpoint: '', openaiCompatible: true }, 'anthropic-messages'],
    [{ provider: 'google', endpoint: '', openaiCompatible: true }, 'google-generative-ai'],
    [{ endpoint: '   ', openaiCompatible: true }, 'openai-responses'],
    [{ provider: 'anthropic', endpoint: '   ', openaiCompatible: true }, 'anthropic-messages'],
    [{ provider: 'google', endpoint: '   ', openaiCompatible: true }, 'google-generative-ai'],
    [{ endpoint: 'https://proxy.test/v1', openaiCompatible: true }, 'openai-chat-completions'],
    [{ endpoint: 'https://proxy.test/v1' }, 'openai-chat-completions'],
    [
      { provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1' },
      'openai-chat-completions',
    ],
    [{ provider: 'anthropic', endpoint: 'https://proxy.test/vendors/a' }, 'anthropic-messages'],
    [{ provider: 'google', endpoint: 'https://x.googleapis.com/models' }, 'google-generative-ai'],
    [{ endpoint: 'https://proxy.test/api' }, 'openai-chat-completions'],
    [{}, 'openai-responses'],
    [{ provider: 'anthropic' }, 'anthropic-messages'],
    [{ provider: 'google' }, 'google-generative-ai'],
  ] as const)('maps %j to %s', (overrides, expected) => {
    const input = legacy(overrides);
    const expectedAgent: LegacyAgent = { ...input, apiProtocol: expected };
    delete expectedAgent.openaiCompatible;
    if (typeof input.endpoint === 'string' && input.endpoint.trim() === '') {
      delete expectedAgent.endpoint;
    }

    expect(migrateAgentToV2(input)).toEqual(expectedAgent);
    expect(migrateAgentToV2(input)).not.toHaveProperty('openaiCompatible');
  });

  it('is deterministic, idempotent, and does not mutate input', () => {
    const input = legacy({
      provider: 'anthropic',
      openaiCompatible: false,
      harmless: { kept: true },
    });
    const original = structuredClone(input);
    const first = migrateAgentToV2(input);
    expect(migrateAgentToV2(first)).toEqual(first);
    expect(input).toEqual(original);
  });

  it('does not access the network', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    migrateAgentToV2(legacy({ endpoint: 'https://proxy.test/v1' }));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it.each([
    null,
    { ...legacy(), provider: 'other' },
    { ...legacy(), model: '' },
    { ...legacy(), endpoint: 3 },
    { ...legacy(), openaiCompatible: 'yes' },
    { ...legacy(), apiProtocol: 'other' },
    { ...legacy(), apiProtocol: 'openai-responses', openaiCompatible: true },
  ])('rejects invalid transport input', (input) => {
    expect(() => migrateAgentToV2(input)).toThrow();
  });
});
