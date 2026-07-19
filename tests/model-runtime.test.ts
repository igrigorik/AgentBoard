import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../src/lib/storage/config';

const mocks = vi.hoisted(() => {
  const responsesModel = { transport: 'responses' };
  const chatModel = { transport: 'chat' };
  const anthropicModel = { transport: 'anthropic' };
  const googleModel = { transport: 'google' };
  const openAIProvider = {
    responses: vi.fn(() => responsesModel),
    chat: vi.fn(() => chatModel),
  };
  const anthropicProvider = vi.fn(() => anthropicModel);
  const googleProvider = vi.fn(() => googleModel);

  return {
    responsesModel,
    chatModel,
    anthropicModel,
    googleModel,
    openAIProvider,
    anthropicProvider,
    googleProvider,
    createOpenAI: vi.fn(() => openAIProvider),
    createAnthropic: vi.fn(() => anthropicProvider),
    createGoogleGenerativeAI: vi.fn(() => googleProvider),
  };
});

vi.mock('@ai-sdk/openai', () => ({ createOpenAI: mocks.createOpenAI }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: mocks.createAnthropic }));
vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: mocks.createGoogleGenerativeAI,
}));

import { createModelRuntime } from '../src/lib/ai/model-runtime';

function createAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-1',
    name: 'Agent',
    provider: 'openai',
    apiKey: 'secret-key',
    model: 'opaque-model',
    endpoint: 'https://gateway.example.test/nested/v1',
    apiProtocol: 'openai-responses',
    systemPrompt: '',
    temperature: 0.7,
    maxTokens: 1000,
    ...overrides,
  };
}

describe('createModelRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('constructs explicit OpenAI Responses with store disabled', () => {
    const runtime = createModelRuntime(
      createAgent({
        reasoning: {
          enabled: true,
          openai: {
            reasoningEffort: 'high',
            reasoningSummary: 'detailed',
          },
        },
      })
    );

    expect(mocks.createOpenAI).toHaveBeenCalledWith({
      apiKey: 'secret-key',
      baseURL: 'https://gateway.example.test/nested/v1',
    });
    expect(mocks.openAIProvider.responses).toHaveBeenCalledWith('opaque-model');
    expect(mocks.openAIProvider.chat).not.toHaveBeenCalled();
    expect(runtime).toEqual({
      apiProtocol: 'openai-responses',
      model: mocks.responsesModel,
      providerOptions: {
        openai: {
          store: false,
          reasoningEffort: 'high',
          reasoningSummary: 'detailed',
        },
      },
    });
  });

  it('always disables Responses storage when reasoning is off', () => {
    const runtime = createModelRuntime(createAgent());

    expect(runtime.providerOptions).toEqual({ openai: { store: false } });
  });

  it('constructs explicit Chat Completions without Responses-only options', () => {
    const runtime = createModelRuntime(
      createAgent({
        apiProtocol: 'openai-chat-completions',
        reasoning: {
          enabled: true,
          openai: {
            reasoningEffort: 'low',
            reasoningSummary: 'auto',
          },
        },
      })
    );

    expect(mocks.openAIProvider.chat).toHaveBeenCalledWith('opaque-model');
    expect(mocks.openAIProvider.responses).not.toHaveBeenCalled();
    expect(runtime).toEqual({
      apiProtocol: 'openai-chat-completions',
      model: mocks.chatModel,
      providerOptions: { openai: { reasoningEffort: 'low' } },
    });
  });

  it('constructs native Anthropic with protocol-owned thinking options', () => {
    const runtime = createModelRuntime(
      createAgent({
        provider: 'anthropic',
        apiProtocol: 'anthropic-messages',
        reasoning: {
          enabled: true,
          anthropic: { thinkingBudgetTokens: 4096 },
        },
      })
    );

    expect(mocks.createAnthropic).toHaveBeenCalledWith({
      apiKey: 'secret-key',
      baseURL: 'https://gateway.example.test/nested/v1',
    });
    expect(mocks.anthropicProvider).toHaveBeenCalledWith('opaque-model');
    expect(runtime).toEqual({
      apiProtocol: 'anthropic-messages',
      model: mocks.anthropicModel,
      providerOptions: {
        anthropic: {
          thinking: { type: 'enabled', budgetTokens: 4096 },
        },
      },
    });
  });

  it('adds Anthropic direct-browser access only without a custom endpoint', () => {
    createModelRuntime(
      createAgent({
        provider: 'anthropic',
        apiProtocol: 'anthropic-messages',
        endpoint: undefined,
      })
    );

    expect(mocks.createAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: undefined,
        headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
        fetch: expect.any(Function),
      })
    );
  });

  it('constructs native Google with protocol-owned thinking options', () => {
    const runtime = createModelRuntime(
      createAgent({
        provider: 'google',
        apiProtocol: 'google-generative-ai',
        reasoning: {
          enabled: true,
          google: { thinkingBudget: 256, includeThoughts: false },
        },
      })
    );

    expect(mocks.createGoogleGenerativeAI).toHaveBeenCalledWith({
      apiKey: 'secret-key',
      baseURL: 'https://gateway.example.test/nested/v1',
    });
    expect(mocks.googleProvider).toHaveBeenCalledWith('opaque-model');
    expect(runtime).toEqual({
      apiProtocol: 'google-generative-ai',
      model: mocks.googleModel,
      providerOptions: {
        google: {
          thinkingConfig: { thinkingBudget: 256, includeThoughts: false },
        },
      },
    });
  });

  it('fails closed before constructing a provider for an unknown protocol', () => {
    const agent = {
      ...createAgent(),
      apiProtocol: 'unknown-protocol',
    } as unknown as AgentConfig;

    expect(() => createModelRuntime(agent)).toThrow(
      'Unsupported agent API protocol: unknown-protocol'
    );
    expect(mocks.createOpenAI).not.toHaveBeenCalled();
    expect(mocks.createAnthropic).not.toHaveBeenCalled();
    expect(mocks.createGoogleGenerativeAI).not.toHaveBeenCalled();
  });
});
