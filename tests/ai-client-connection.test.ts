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

import { AIClient } from '../src/lib/ai/client';
import { getToolRegistry } from '../src/lib/webmcp/tool-registry';

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

function remoteSession(hasContext = false) {
  return {
    hasContext,
    signal: new AbortController().signal,
  };
}

function revocableRemoteSession() {
  const controller = new AbortController();
  return {
    controller,
    session: { hasContext: true, signal: controller.signal },
  };
}

function toolRegistry(tools: Record<string, unknown> = {}, session = remoteSession()) {
  return {
    captureToolSnapshot: () => ({ tools, remoteSession: session }),
    onTabToolsChanged: () => () => undefined,
  };
}

function storeAgent(agentId: string): void {
  vi.mocked(chrome.storage.local.get).mockResolvedValue({
    config: {
      schemaVersion: 2,
      agents: [
        {
          id: agentId,
          name: 'Private Agent',
          provider: 'openai',
          apiProtocol: 'openai-responses',
          apiKey: 'secret-key',
          model: 'secret-model',
          endpoint: 'https://secret.example.test/v1',
          systemPrompt: '',
          temperature: 0.7,
        },
      ],
    },
  } as never);
}

function deferredAsyncTextStream() {
  let resolve!: (value: IteratorResult<string>) => void;
  let reject!: (error: unknown) => void;
  const nextResult = new Promise<IteratorResult<string>>((resolveResult, rejectResult) => {
    resolve = resolveResult;
    reject = rejectResult;
  });
  return {
    stream: {
      [Symbol.asyncIterator]() {
        return { next: () => nextResult };
      },
    },
    resolve,
    reject,
  };
}

describe('AIClient connection testing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);
    vi.mocked(getToolRegistry).mockReturnValue(toolRegistry() as never);
    mocks.streamText.mockReturnValue({ textStream: successfulTextStream() });
  });

  it('uses the explicitly selected Responses API', async () => {
    const result = await AIClient.getInstance().testConnectionWithDetails({
      apiProtocol: 'openai-responses',
      apiKey: 'sk-test',
      model: 'gpt-5.6-sol',
      endpoint: 'https://gateway.example.test/v1',
    });

    expect(result).toEqual({ success: true, message: 'Connection successful.' });
    expect(JSON.stringify(result)).not.toContain('gateway.example.test');
    expect(JSON.stringify(result)).not.toContain('gpt-5.6-sol');
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

  it('explains that an empty stream can indicate an API contract mismatch', async () => {
    mocks.streamText.mockReturnValue({
      textStream: textStream(async () => ({ done: true, value: undefined })),
    });

    const result = await AIClient.getInstance().testConnectionWithDetails({
      apiProtocol: 'openai-chat-completions',
      model: 'opaque-model',
      endpoint: 'https://example.test/v1',
    });

    expect(result).toEqual({
      success: false,
      message: 'Endpoint returned no text. Verify it implements the selected Connection API.',
    });
    expect(JSON.stringify(result)).not.toContain('example.test');
    expect(JSON.stringify(result)).not.toContain('opaque-model');
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
      message: 'AI request failed. Verify the Connection API, endpoint, model, and credentials.',
    });
    expect(result.message).not.toContain('upstream stream failed');
    expect(signal?.aborted).toBe(true);
  });

  it('keeps cancellation ownership scoped to each overlapping stream', async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue({
      config: {
        schemaVersion: 2,
        agents: ['agent-a', 'agent-b'].map((id) => ({
          id,
          name: id,
          provider: 'openai',
          apiProtocol: 'openai-responses',
          apiKey: 'secret-key',
          model: 'test-model',
          systemPrompt: '',
          temperature: 0.7,
        })),
      },
    } as never);
    const first = deferredAsyncTextStream();
    const second = deferredAsyncTextStream();
    let firstSignal: AbortSignal | undefined;
    let secondSignal: AbortSignal | undefined;
    mocks.streamText
      .mockImplementationOnce((options: { abortSignal?: AbortSignal }) => {
        firstSignal = options.abortSignal;
        return { textStream: first.stream, fullStream: undefined };
      })
      .mockImplementationOnce((options: { abortSignal?: AbortSignal }) => {
        secondSignal = options.abortSignal;
        return { textStream: second.stream, fullStream: undefined };
      });
    const firstOnError = vi.fn();
    const secondOnError = vi.fn();
    const firstOnAbort = vi.fn();
    const secondOnAbort = vi.fn();

    const firstRequest = AIClient.getInstance().streamChat(
      'agent-a',
      [],
      undefined,
      {
        onFinish: vi.fn(),
        onError: firstOnError,
        onAbort: firstOnAbort,
      },
      'stream-a'
    );
    await vi.waitFor(() => expect(mocks.streamText).toHaveBeenCalledTimes(1));
    const secondRequest = AIClient.getInstance().streamChat(
      'agent-b',
      [],
      undefined,
      {
        onFinish: vi.fn(),
        onError: secondOnError,
        onAbort: secondOnAbort,
      },
      'stream-b'
    );
    await vi.waitFor(() => expect(mocks.streamText).toHaveBeenCalledTimes(2));

    expect(firstSignal?.aborted).toBe(true);
    expect(secondSignal?.aborted).toBe(false);
    // Supersession settles the old caller before an abort-ignoring provider settles.
    expect(firstOnAbort).toHaveBeenCalledTimes(1);
    await firstRequest;
    expect(firstOnError).not.toHaveBeenCalled();
    first.reject(new Error('late provider failure'));
    expect(firstOnAbort).toHaveBeenCalledTimes(1);

    expect(AIClient.getInstance().cancelStream('stream-a')).toBe(false);
    expect(secondSignal?.aborted).toBe(false);
    expect(AIClient.getInstance().cancelStream('stream-b')).toBe(true);
    expect(secondSignal?.aborted).toBe(true);
    await secondRequest;
    expect(secondOnError).not.toHaveBeenCalled();
    second.reject(new Error('late provider failure'));
    expect(secondOnAbort).toHaveBeenCalledTimes(1);
  });

  it('does not let slower setup from an older invocation overtake a newer stream', async () => {
    const client = AIClient.getInstance();
    const configStorage = (
      client as unknown as {
        configStorage: { getAgent: (id: string) => Promise<unknown> };
      }
    ).configStorage;
    let resolveFirstAgent!: (agent: unknown) => void;
    const firstAgent = new Promise<unknown>((resolve) => {
      resolveFirstAgent = resolve;
    });
    const agent = {
      id: 'agent',
      name: 'Agent',
      provider: 'openai',
      apiProtocol: 'openai-responses',
      apiKey: 'secret-key',
      model: 'test-model',
      systemPrompt: '',
      temperature: 0.7,
    };
    const getAgent = vi
      .spyOn(configStorage, 'getAgent')
      .mockImplementationOnce(() => firstAgent)
      .mockResolvedValueOnce(agent);
    const active = deferredAsyncTextStream();
    let activeSignal: AbortSignal | undefined;
    mocks.streamText.mockImplementation((options: { abortSignal?: AbortSignal }) => {
      activeSignal = options.abortSignal;
      return { textStream: active.stream, fullStream: undefined };
    });
    const firstOnError = vi.fn();
    const secondOnError = vi.fn();
    const firstOnAbort = vi.fn();
    const secondOnAbort = vi.fn();

    try {
      const firstRequest = client.streamChat(
        'agent',
        [],
        undefined,
        { onFinish: vi.fn(), onError: firstOnError, onAbort: firstOnAbort },
        'setup-a'
      );
      const secondRequest = client.streamChat(
        'agent',
        [],
        undefined,
        { onFinish: vi.fn(), onError: secondOnError, onAbort: secondOnAbort },
        'setup-b'
      );
      await vi.waitFor(() => expect(mocks.streamText).toHaveBeenCalledTimes(1));
      expect(activeSignal?.aborted).toBe(false);

      // The newer valid request settles older setup without waiting for storage.
      await firstRequest;
      expect(mocks.streamText).toHaveBeenCalledTimes(1);
      expect(firstOnError).not.toHaveBeenCalled();
      expect(firstOnAbort).toHaveBeenCalledTimes(1);
      expect(activeSignal?.aborted).toBe(false);
      resolveFirstAgent(agent);
      await Promise.resolve();
      expect(mocks.streamText).toHaveBeenCalledTimes(1);

      expect(client.cancelStream('setup-a')).toBe(false);
      expect(client.cancelStream('setup-b')).toBe(true);
      active.reject(new DOMException('cancelled', 'AbortError'));
      await secondRequest;
      expect(secondOnError).not.toHaveBeenCalled();
      expect(secondOnAbort).toHaveBeenCalledTimes(1);
    } finally {
      getAgent.mockRestore();
    }
  });

  it('cancels ownership while agent setup is still pending', async () => {
    const client = AIClient.getInstance();
    const configStorage = (
      client as unknown as {
        configStorage: { getAgent: (id: string) => Promise<unknown> };
      }
    ).configStorage;
    let resolveAgent!: (agent: unknown) => void;
    const pendingAgent = new Promise<unknown>((resolve) => {
      resolveAgent = resolve;
    });
    const getAgent = vi.spyOn(configStorage, 'getAgent').mockReturnValueOnce(pendingAgent);
    const onAbort = vi.fn();
    const onError = vi.fn();

    try {
      const request = client.streamChat(
        'pending-agent',
        [],
        undefined,
        { onFinish: vi.fn(), onError, onAbort },
        'pending-setup'
      );

      expect(client.cancelStream('pending-setup')).toBe(true);
      expect(onAbort).toHaveBeenCalledTimes(1);
      await request;
      expect(mocks.streamText).not.toHaveBeenCalled();

      // The abandoned storage operation may settle later without reviving the request.
      resolveAgent({
        id: 'pending-agent',
        name: 'Pending Agent',
        provider: 'openai',
        apiProtocol: 'openai-responses',
        apiKey: 'secret-key',
        model: 'test-model',
        systemPrompt: '',
        temperature: 0.7,
      });
      await Promise.resolve();

      expect(mocks.streamText).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(client.cancelStream('pending-setup')).toBe(false);
    } finally {
      getAgent.mockRestore();
    }
  });

  it('aborts exactly once when the captured remote MCP session is revoked', async () => {
    storeAgent('remote-session-agent');
    const remote = revocableRemoteSession();
    vi.mocked(getToolRegistry).mockReturnValue(toolRegistry({}, remote.session) as never);
    const active = deferredAsyncTextStream();
    let providerSignal: AbortSignal | undefined;
    mocks.streamText.mockImplementation((options: { abortSignal?: AbortSignal }) => {
      providerSignal = options.abortSignal;
      return { textStream: active.stream, fullStream: undefined };
    });
    const onAbort = vi.fn();
    const onError = vi.fn();
    const onFinish = vi.fn();
    const request = AIClient.getInstance().streamChat(
      'remote-session-agent',
      [],
      undefined,
      { onFinish, onError, onAbort },
      'remote-session-stream'
    );
    await vi.waitFor(() => expect(mocks.streamText).toHaveBeenCalledTimes(1));

    remote.controller.abort();
    await request;

    expect(providerSignal?.aborted).toBe(true);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(onAbort).toHaveBeenCalledWith('remote-tools-changed');
    expect(onError).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('does not cancel a valid active stream when a newer request is invalid', async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue({
      config: {
        schemaVersion: 2,
        agents: [
          {
            id: 'valid-agent',
            name: 'Valid Agent',
            provider: 'openai',
            apiProtocol: 'openai-responses',
            apiKey: 'secret-key',
            model: 'test-model',
            systemPrompt: '',
            temperature: 0.7,
          },
        ],
      },
    } as never);
    const active = deferredAsyncTextStream();
    let activeSignal: AbortSignal | undefined;
    mocks.streamText.mockImplementation((options: { abortSignal?: AbortSignal }) => {
      activeSignal = options.abortSignal;
      return { textStream: active.stream, fullStream: undefined };
    });
    const activeOnAbort = vi.fn();
    const invalidOnError = vi.fn();

    const activeRequest = AIClient.getInstance().streamChat(
      'valid-agent',
      [],
      undefined,
      { onFinish: vi.fn(), onError: vi.fn(), onAbort: activeOnAbort },
      'valid-stream'
    );
    await vi.waitFor(() => expect(mocks.streamText).toHaveBeenCalledTimes(1));

    await AIClient.getInstance().streamChat(
      'missing-agent',
      [],
      undefined,
      { onFinish: vi.fn(), onError: invalidOnError, onAbort: vi.fn() },
      'invalid-stream'
    );

    expect(invalidOnError).toHaveBeenCalledTimes(1);
    expect(mocks.streamText).toHaveBeenCalledTimes(1);
    expect(activeSignal?.aborted).toBe(false);
    expect(activeOnAbort).not.toHaveBeenCalled();

    expect(AIClient.getInstance().cancelStream('valid-stream')).toBe(true);
    active.reject(new DOMException('cancelled', 'AbortError'));
    await activeRequest;
    expect(activeOnAbort).toHaveBeenCalledTimes(1);
  });

  it('does not expose tool-error payloads to sidebar callbacks', async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue({
      config: {
        schemaVersion: 2,
        agents: [
          {
            id: 'tool-agent',
            name: 'Tool Agent',
            provider: 'openai',
            apiProtocol: 'openai-responses',
            apiKey: 'secret-key',
            model: 'test-model',
            systemPrompt: '',
            temperature: 0.7,
          },
        ],
      },
    } as never);
    vi.mocked(getToolRegistry).mockReturnValue(toolRegistry({ private_tool: {} }) as never);
    const secret = 'secret tool backend failure';
    mocks.streamText.mockReturnValue({
      textStream: undefined,
      fullStream: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'tool-error',
            toolCallId: 'call-1',
            toolName: 'private_tool',
            input: {},
            error: new Error(secret),
          };
        },
      },
    });
    const onToolResult = vi.fn();

    await AIClient.getInstance().streamChat('tool-agent', [], undefined, {
      onFinish: vi.fn(),
      onError: vi.fn(),
      onToolResult,
    });

    expect(onToolResult).toHaveBeenCalledWith({
      id: 'call-1',
      output: null,
      status: 'error',
      error: 'Tool execution failed',
    });
    expect(JSON.stringify(onToolResult.mock.calls)).not.toContain(secret);
  });

  it('does not expose raw provider failures from normal streams', async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue({
      config: {
        schemaVersion: 2,
        agents: [
          {
            id: 'private-agent',
            name: 'Private Agent',
            provider: 'openai',
            apiProtocol: 'openai-responses',
            apiKey: 'secret-key',
            model: 'secret-model',
            endpoint: 'https://secret.example.test/v1',
            systemPrompt: '',
            temperature: 0.7,
          },
        ],
      },
    } as never);
    const providerFailure = Object.assign(new Error('raw prompt and response'), {
      statusCode: 500,
      responseBody: 'secret provider response',
    });
    mocks.streamText.mockReturnValue({
      textStream: {
        [Symbol.asyncIterator]() {
          return {
            next: async () => Promise.reject(providerFailure),
          };
        },
      },
      fullStream: undefined,
    });
    const onError = vi.fn();

    await AIClient.getInstance().streamChat('private-agent', [], undefined, {
      onFinish: vi.fn(),
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    const publicError = onError.mock.calls[0][0];
    expect(publicError.message).toBe('The AI service is temporarily unavailable. Try again later.');
    expect(publicError).not.toBe(providerFailure);
    expect(publicError).not.toHaveProperty('responseBody');
    expect(publicError.message).not.toContain('raw prompt and response');
  });

  it('owns and sanitizes full-stream SDK error parts without finishing', async () => {
    storeAgent('full-stream-error-agent');
    vi.mocked(getToolRegistry).mockReturnValue(toolRegistry({ private_tool: {} }) as never);
    const providerFailure = new DOMException('secret full-stream provider failure', 'AbortError');
    mocks.streamText.mockImplementation(
      (options: { onError?: (event: { error: unknown }) => void }) => {
        options.onError?.({ error: providerFailure });
        return {
          textStream: undefined,
          fullStream: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'error', error: providerFailure };
            },
          },
        };
      }
    );
    const onFinish = vi.fn();
    const onError = vi.fn();
    const onAbort = vi.fn();

    await AIClient.getInstance().streamChat('full-stream-error-agent', [], undefined, {
      onFinish,
      onError,
      onAbort,
    });

    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.objectContaining({ onError: expect.any(Function) })
    );
    expect(onFinish).not.toHaveBeenCalled();
    expect(onAbort).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({
      message: 'AI request failed. Verify the Connection API, endpoint, model, and credentials.',
    });
    expect(JSON.stringify(onError.mock.calls)).not.toContain(providerFailure.message);
    expect(vi.mocked(console.error).mock.calls.flat().map(String).join('\n')).not.toContain(
      providerFailure.message
    );
  });

  it('owns text-stream SDK errors that are not exposed as stream parts', async () => {
    storeAgent('text-stream-error-agent');
    const providerFailure = new DOMException('secret text-stream provider failure', 'AbortError');
    mocks.streamText.mockImplementation(
      (options: { onError?: (event: { error: unknown }) => void }) => ({
        fullStream: undefined,
        textStream: {
          async *[Symbol.asyncIterator]() {
            yield 'partial';
            options.onError?.({ error: providerFailure });
          },
        },
      })
    );
    const onFinish = vi.fn();
    const onError = vi.fn();
    const onAbort = vi.fn();

    await AIClient.getInstance().streamChat('text-stream-error-agent', [], undefined, {
      onFinish,
      onError,
      onAbort,
    });

    expect(onFinish).not.toHaveBeenCalled();
    expect(onAbort).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({
      message: 'AI request failed. Verify the Connection API, endpoint, model, and credentials.',
    });
    expect(JSON.stringify(onError.mock.calls)).not.toContain(providerFailure.message);
    expect(vi.mocked(console.error).mock.calls.flat().map(String).join('\n')).not.toContain(
      providerFailure.message
    );
  });

  it('owns and sanitizes connection-probe SDK errors', async () => {
    const providerFailure = new DOMException('secret probe provider failure', 'AbortError');
    mocks.streamText.mockImplementation(
      (options: { onError?: (event: { error: unknown }) => void }) => {
        options.onError?.({ error: providerFailure });
        return { textStream: successfulTextStream() };
      }
    );

    const result = await AIClient.getInstance().testConnectionWithDetails({
      apiProtocol: 'openai-responses',
      apiKey: 'secret-key',
      model: 'secret-model',
      endpoint: 'https://secret.example.test/v1',
    });

    expect(result).toEqual({
      success: false,
      message: 'AI request failed. Verify the Connection API, endpoint, model, and credentials.',
    });
    expect(JSON.stringify(result)).not.toContain(providerFailure.message);
    expect(vi.mocked(console.error).mock.calls.flat().map(String).join('\n')).not.toContain(
      providerFailure.message
    );
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
        message: 'The AI request timed out. Try again.',
      });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
