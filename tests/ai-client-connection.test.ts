import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const responsesModel = { transport: 'responses' };
  const chatModel = { transport: 'chat-completions' };
  const openAIProvider = {
    responses: vi.fn(() => responsesModel),
    chat: vi.fn(() => chatModel),
  };

  return {
    responsesModel,
    chatModel,
    openAIProvider,
    createOpenAI: vi.fn(() => openAIProvider),
    streamText: vi.fn(),
  };
});

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mocks.createOpenAI,
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(),
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(),
}));

vi.mock('ai', () => ({
  streamText: mocks.streamText,
}));

vi.mock('../src/lib/webmcp/tool-registry', () => ({
  getToolRegistry: vi.fn(),
}));

vi.mock('../src/lib/mcp/manager', () => ({
  getRemoteMCPManager: vi.fn(),
}));

import { AIClient } from '../src/lib/ai/client';

function textStream(read: () => Promise<ReadableStreamReadResult<string>>) {
  return {
    getReader: () => ({
      read,
      releaseLock: vi.fn(),
    }),
  };
}

function successfulTextStream() {
  return textStream(async () => ({ done: false, value: 'OK' }));
}

describe('AIClient connection testing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);
    mocks.streamText.mockReturnValue({ textStream: successfulTextStream() });
  });

  it('uses the explicitly selected Responses API', async () => {
    const result = await AIClient.getInstance().testConnectionWithDetails({
      apiProtocol: 'openai-responses',
      apiKey: 'sk-test',
      model: 'gpt-5.6-sol',
      endpoint: 'https://gateway.example.test/v1',
    });

    expect(result.success).toBe(true);
    expect(mocks.openAIProvider.responses).toHaveBeenCalledWith('gpt-5.6-sol');
    expect(mocks.openAIProvider.chat).not.toHaveBeenCalled();
    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: mocks.responsesModel,
        maxRetries: 0,
        providerOptions: { openai: { store: false } },
      })
    );
  });

  it('uses explicitly selected Chat Completions', async () => {
    const result = await AIClient.getInstance().testConnectionWithDetails({
      apiProtocol: 'openai-chat-completions',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      endpoint: 'https://example.test/v1',
    });

    expect(result.success).toBe(true);
    expect(mocks.openAIProvider.chat).toHaveBeenCalledWith('gpt-4o');
    expect(mocks.openAIProvider.responses).not.toHaveBeenCalled();
    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.objectContaining({ model: mocks.chatModel })
    );
  });

  it('routes saved agents through the same zero-retry probe path', async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue({
      config: {
        schemaVersion: 2,
        agents: [
          {
            id: 'saved-agent',
            name: 'Saved',
            provider: 'anthropic',
            apiProtocol: 'openai-chat-completions',
            model: 'opaque-model',
            endpoint: 'https://example.test/v1',
            systemPrompt: '',
            temperature: 0.7,
            maxTokens: 1000,
          },
        ],
      },
    } as never);

    const result = await AIClient.getInstance().testConnection('saved-agent');

    expect(result.success).toBe(true);
    expect(mocks.openAIProvider.chat).toHaveBeenCalledWith('opaque-model');
    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.objectContaining({ model: mocks.chatModel, maxRetries: 0 })
    );
  });

  it('does not let a /v1 endpoint override explicit Responses selection', async () => {
    const result = await AIClient.getInstance().testConnectionWithDetails({
      apiProtocol: 'openai-responses',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      endpoint: 'https://example.test/v1',
    });

    expect(result.success).toBe(true);
    expect(mocks.openAIProvider.responses).toHaveBeenCalledWith('gpt-4o');
    expect(mocks.openAIProvider.chat).not.toHaveBeenCalled();
  });

  it('aborts the provider request after the first successful chunk', async () => {
    let signal: AbortSignal | undefined;
    mocks.streamText.mockImplementation((options: { abortSignal?: AbortSignal }) => {
      signal = options.abortSignal;
      return { textStream: successfulTextStream() };
    });

    const result = await AIClient.getInstance().testConnectionWithDetails({
      apiProtocol: 'openai-responses',
      apiKey: 'sk-test',
      model: 'gpt-5.6-sol',
      endpoint: 'https://gateway.example.test/v1',
    });

    expect(result.success).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  it('aborts the provider request when stream consumption fails', async () => {
    let signal: AbortSignal | undefined;
    mocks.streamText.mockImplementation((options: { abortSignal?: AbortSignal }) => {
      signal = options.abortSignal;
      return {
        textStream: textStream(async () => Promise.reject(new Error('upstream stream failed'))),
      };
    });

    const result = await AIClient.getInstance().testConnectionWithDetails({
      apiProtocol: 'openai-chat-completions',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      endpoint: 'https://example.test/v1',
    });

    expect(result).toEqual({
      success: false,
      message:
        'Connection failed for openai. Verify the Connection API, endpoint, model, and credentials.',
    });
    expect(result.message).not.toContain('upstream stream failed');
    expect(signal?.aborted).toBe(true);
  });

  it('aborts the provider request when the connection test times out', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    mocks.streamText.mockImplementation((options: { abortSignal?: AbortSignal }) => {
      signal = options.abortSignal;
      return {
        textStream: textStream(async () => {
          await new Promise(() => {});
          return { done: false, value: 'unreachable' };
        }),
      };
    });

    try {
      const resultPromise = AIClient.getInstance().testConnectionWithDetails({
        apiProtocol: 'openai-chat-completions',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        endpoint: 'https://example.test/v1',
      });

      await vi.advanceTimersByTimeAsync(10000);
      const result = await resultPromise;

      expect(result).toEqual({
        success: false,
        message: 'Connection timeout. The openai API took too long to respond.',
      });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
