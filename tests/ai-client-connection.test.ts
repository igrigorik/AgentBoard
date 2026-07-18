import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const responsesModel = { transport: 'responses' };
  const chatModel = { transport: 'chat-completions' };
  const openAIProvider = Object.assign(
    vi.fn(() => responsesModel),
    {
      chat: vi.fn(() => chatModel),
    }
  );

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

function successfulTextStream() {
  return (async function* () {
    yield 'OK';
  })();
}

describe('AIClient connection testing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.streamText.mockReturnValue({ textStream: successfulTextStream() });
  });

  it('uses the Responses API when OpenAI compatibility is explicitly disabled', async () => {
    const result = await AIClient.getInstance().testConnectionWithDetails({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-5.6-sol',
      endpoint: 'https://proxy.shopify.ai/v1',
      openaiCompatible: false,
    });

    expect(result.success).toBe(true);
    expect(mocks.openAIProvider).toHaveBeenCalledWith('gpt-5.6-sol');
    expect(mocks.openAIProvider.chat).not.toHaveBeenCalled();
    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.objectContaining({ model: mocks.responsesModel })
    );
  });

  it('uses Chat Completions when OpenAI compatibility is explicitly enabled', async () => {
    const result = await AIClient.getInstance().testConnectionWithDetails({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      endpoint: 'https://example.test/v1',
      openaiCompatible: true,
    });

    expect(result.success).toBe(true);
    expect(mocks.openAIProvider.chat).toHaveBeenCalledWith('gpt-4o');
    expect(mocks.openAIProvider).not.toHaveBeenCalled();
    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.objectContaining({ model: mocks.chatModel })
    );
  });

  it('preserves URL-based Chat Completions inference when no choice was made', async () => {
    const result = await AIClient.getInstance().testConnectionWithDetails({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      endpoint: 'https://example.test/v1',
    });

    expect(result.success).toBe(true);
    expect(mocks.openAIProvider.chat).toHaveBeenCalledWith('gpt-4o');
    expect(mocks.openAIProvider).not.toHaveBeenCalled();
  });

  it('aborts the provider request after the first successful chunk', async () => {
    let signal: AbortSignal | undefined;
    mocks.streamText.mockImplementation((options: { abortSignal?: AbortSignal }) => {
      signal = options.abortSignal;
      return { textStream: successfulTextStream() };
    });

    const result = await AIClient.getInstance().testConnectionWithDetails({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-5.6-sol',
      endpoint: 'https://proxy.shopify.ai/v1',
      openaiCompatible: false,
    });

    expect(result.success).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  it('aborts the provider request when stream consumption fails', async () => {
    let signal: AbortSignal | undefined;
    mocks.streamText.mockImplementation((options: { abortSignal?: AbortSignal }) => {
      signal = options.abortSignal;
      return {
        textStream: (async function* () {
          yield await Promise.reject(new Error('upstream stream failed'));
        })(),
      };
    });

    const result = await AIClient.getInstance().testConnectionWithDetails({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      endpoint: 'https://example.test/v1',
      openaiCompatible: true,
    });

    expect(result).toEqual({
      success: false,
      message: 'Connection failed: upstream stream failed',
    });
    expect(signal?.aborted).toBe(true);
  });

  it('aborts the provider request when the connection test times out', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    mocks.streamText.mockImplementation((options: { abortSignal?: AbortSignal }) => {
      signal = options.abortSignal;
      return {
        textStream: (async function* () {
          await new Promise(() => {});
          yield 'unreachable';
        })(),
      };
    });

    try {
      const resultPromise = AIClient.getInstance().testConnectionWithDetails({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        endpoint: 'https://example.test/v1',
        openaiCompatible: true,
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
