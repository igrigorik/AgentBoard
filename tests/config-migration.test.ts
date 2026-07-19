import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../src/lib/storage/config';
import { migrateAgentToV2 } from '../src/lib/storage/config-migration';

function createAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-1',
    name: 'Agent',
    provider: 'openai',
    model: 'opaque-model',
    systemPrompt: '',
    temperature: 0.7,
    maxTokens: 1000,
    ...overrides,
  };
}

describe('migrateAgentToV2', () => {
  it.each([
    {
      name: 'explicit OpenAI-compatible transport',
      agent: createAgent({ endpoint: 'https://gateway.example.test/api', openaiCompatible: true }),
      expected: 'openai-chat-completions',
    },
    {
      name: 'explicit OpenAI native transport',
      agent: createAgent({ endpoint: 'https://gateway.example.test/api', openaiCompatible: false }),
      expected: 'openai-responses',
    },
    {
      name: 'explicit Anthropic native transport',
      agent: createAgent({
        provider: 'anthropic',
        endpoint: 'https://gateway.example.test/api',
        openaiCompatible: false,
      }),
      expected: 'anthropic-messages',
    },
    {
      name: 'explicit Google native transport',
      agent: createAgent({
        provider: 'google',
        endpoint: 'https://gateway.example.test/api',
        openaiCompatible: false,
      }),
      expected: 'google-generative-ai',
    },
    {
      name: 'legacy /v1 endpoint',
      agent: createAgent({ endpoint: 'https://gateway.example.test/v1' }),
      expected: 'openai-chat-completions',
    },
    {
      name: 'legacy /v1 precedence over Anthropic host',
      agent: createAgent({
        provider: 'anthropic',
        endpoint: 'https://api.anthropic.com/v1',
      }),
      expected: 'openai-chat-completions',
    },
    {
      name: 'legacy vendor-native endpoint',
      agent: createAgent({
        provider: 'anthropic',
        endpoint: 'https://gateway.example.test/vendors/anthropic',
      }),
      expected: 'anthropic-messages',
    },
    {
      name: 'legacy Anthropic-native endpoint',
      agent: createAgent({
        provider: 'anthropic',
        endpoint: 'https://api.anthropic.com/messages',
      }),
      expected: 'anthropic-messages',
    },
    {
      name: 'legacy Google-native endpoint',
      agent: createAgent({
        provider: 'google',
        endpoint: 'https://generativelanguage.googleapis.com/models',
      }),
      expected: 'google-generative-ai',
    },
    {
      name: 'legacy unknown custom endpoint',
      agent: createAgent({ endpoint: 'https://gateway.example.test/api' }),
      expected: 'openai-chat-completions',
    },
    {
      name: 'direct OpenAI',
      agent: createAgent(),
      expected: 'openai-responses',
    },
    {
      name: 'direct Anthropic',
      agent: createAgent({ provider: 'anthropic' }),
      expected: 'anthropic-messages',
    },
    {
      name: 'direct Google',
      agent: createAgent({ provider: 'google' }),
      expected: 'google-generative-ai',
    },
  ] as const)('maps $name to $expected', ({ agent, expected }) => {
    expect(migrateAgentToV2(agent)).toEqual({
      ...agent,
      openaiCompatible: undefined,
      apiProtocol: expected,
    });
    expect(migrateAgentToV2(agent)).not.toHaveProperty('openaiCompatible');
  });

  it('is deterministic, idempotent, and does not mutate its input', () => {
    const legacy = createAgent({
      provider: 'anthropic',
      endpoint: 'https://gateway.example.test/vendors/anthropic',
    });
    const original = structuredClone(legacy);

    const first = migrateAgentToV2(legacy);
    const second = migrateAgentToV2(first);

    expect(first).toEqual(second);
    expect(legacy).toEqual(original);
  });

  it('never performs network access', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    migrateAgentToV2(createAgent({ endpoint: 'https://gateway.example.test/v1' }));

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it.each([
    { name: 'non-object input', agent: null },
    { name: 'missing provider', agent: { ...createAgent(), provider: undefined } },
    { name: 'unknown provider', agent: { ...createAgent(), provider: 'unknown' } },
    { name: 'missing model', agent: { ...createAgent(), model: '' } },
    { name: 'non-string endpoint', agent: { ...createAgent(), endpoint: 42 } },
    {
      name: 'malformed compatibility setting',
      agent: { ...createAgent(), openaiCompatible: 'true' },
    },
    { name: 'unknown current protocol', agent: { ...createAgent(), apiProtocol: 'unknown' } },
    {
      name: 'conflicting current and legacy protocols',
      agent: {
        ...createAgent(),
        apiProtocol: 'openai-responses',
        openaiCompatible: true,
      },
    },
  ])('rejects $name', ({ agent }) => {
    expect(() => migrateAgentToV2(agent)).toThrow();
  });
});
