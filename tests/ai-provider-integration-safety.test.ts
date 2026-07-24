import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAIIntegrationSchedule,
  formatAIIntegrationPreflight,
  formatAIIntegrationSummary,
  runAIIntegrationTarget,
  sanitizeAIIntegrationFailure,
  shouldRunAIIntegration,
} from './integration/ai-provider-runner';

const secrets = {
  openAIEndpoint: 'https://confidential-openai-gateway.invalid/private',
  anthropicEndpoint: 'https://confidential-anthropic-gateway.invalid/private',
  responsesModel: 'confidential-responses-model',
  chatModel: 'confidential-chat-model',
  anthropicModel: 'confidential-anthropic-model',
  apiKey: 'confidential-api-key',
  rawError: 'raw provider failure containing confidential request details',
};

function proxyEnvironment(): NodeJS.ProcessEnv {
  return {
    AGENTBOARD_AI_INTEGRATION_TARGETS:
      'proxy-openai-responses,proxy-openai-chat,proxy-anthropic-messages',
    AGENTBOARD_AI_INTEGRATION_CONFIRM_REQUESTS: '3',
    AGENTBOARD_AI_INTEGRATION_PROXY_OPENAI_BASE_URL: secrets.openAIEndpoint,
    AGENTBOARD_AI_INTEGRATION_PROXY_ANTHROPIC_BASE_URL: secrets.anthropicEndpoint,
    AGENTBOARD_AI_INTEGRATION_PROXY_RESPONSES_MODEL: secrets.responsesModel,
    AGENTBOARD_AI_INTEGRATION_PROXY_CHAT_MODEL: secrets.chatModel,
    AGENTBOARD_AI_INTEGRATION_PROXY_ANTHROPIC_MODEL: secrets.anthropicModel,
    AGENTBOARD_AI_INTEGRATION_PROXY_KEY: secrets.apiKey,
  };
}

function expectNoSecrets(value: unknown): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of Object.values(secrets)) expect(serialized).not.toContain(secret);
}

describe('AI provider integration safety', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats a complete preflight without endpoint, model, or credential values', () => {
    const schedule = createAIIntegrationSchedule(proxyEnvironment());
    const output = formatAIIntegrationPreflight(schedule);

    expect(JSON.parse(output)).toEqual({
      mode: 'preflight',
      requestCount: 3,
      targets: [
        { id: 'proxy-openai-responses', apiProtocol: 'openai-responses' },
        { id: 'proxy-openai-chat', apiProtocol: 'openai-chat-completions' },
        { id: 'proxy-anthropic-messages', apiProtocol: 'anthropic-messages' },
      ],
    });
    expectNoSecrets(output);
  });

  it('requires explicit run opt-in', () => {
    expect(shouldRunAIIntegration(proxyEnvironment())).toBe(false);
    expect(
      shouldRunAIIntegration({ ...proxyEnvironment(), RUN_AGENTBOARD_AI_INTEGRATION: '1' })
    ).toBe(true);
  });

  it.each([
    {
      name: 'empty targets',
      overrides: {
        AGENTBOARD_AI_INTEGRATION_TARGETS: ',',
        AGENTBOARD_AI_INTEGRATION_CONFIRM_REQUESTS: '0',
      },
    },
    {
      name: 'duplicate targets',
      overrides: {
        AGENTBOARD_AI_INTEGRATION_TARGETS: 'proxy-openai-responses,proxy-openai-responses',
        AGENTBOARD_AI_INTEGRATION_CONFIRM_REQUESTS: '2',
      },
    },
    {
      name: 'unknown target',
      overrides: {
        AGENTBOARD_AI_INTEGRATION_TARGETS: secrets.openAIEndpoint,
        AGENTBOARD_AI_INTEGRATION_CONFIRM_REQUESTS: '1',
      },
    },
    {
      name: 'mismatched request count',
      overrides: { AGENTBOARD_AI_INTEGRATION_CONFIRM_REQUESTS: '2' },
    },
    {
      name: 'invalid endpoint',
      overrides: { AGENTBOARD_AI_INTEGRATION_PROXY_OPENAI_BASE_URL: secrets.rawError },
    },
  ])('rejects $name without echoing environment values', ({ overrides }) => {
    let caught: unknown;
    try {
      createAIIntegrationSchedule({ ...proxyEnvironment(), ...overrides });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expectNoSecrets((caught as Error).message);
  });

  it('sanitizes raw HTTP failures before returning or formatting results', async () => {
    const target = createAIIntegrationSchedule(proxyEnvironment())[0];
    const rawError = Object.assign(new Error(secrets.rawError), {
      statusCode: 502,
      endpoint: secrets.openAIEndpoint,
      model: secrets.responsesModel,
      apiKey: secrets.apiKey,
    });

    const result = await runAIIntegrationTarget(target, {
      execute: async () => Promise.reject(rawError),
    });
    const summary = formatAIIntegrationSummary({
      commit: 'test-commit',
      timestamp: '2026-07-18T00:00:00.000Z',
      results: [result],
    });

    expect(result).toEqual({
      targetId: 'proxy-openai-responses',
      apiProtocol: 'openai-responses',
      success: false,
      failure: { kind: 'http', statusCode: 502 },
    });
    expectNoSecrets(result);
    expectNoSecrets(summary);
  });

  it('aborts a timed-out execution and waits for it to settle', async () => {
    vi.useFakeTimers();
    const target = createAIIntegrationSchedule(proxyEnvironment())[0];
    let signal: AbortSignal | undefined;
    let releaseExecution: (() => void) | undefined;
    let resultSettled = false;

    const resultPromise = runAIIntegrationTarget(target, {
      timeoutMs: 10,
      execute: (_target, abortSignal) => {
        signal = abortSignal;
        return new Promise<'tool-call'>((resolve) => {
          releaseExecution = () => resolve('tool-call');
        });
      },
    });
    void resultPromise.then(() => {
      resultSettled = true;
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();

    expect(signal?.aborted).toBe(true);
    expect(resultSettled).toBe(false);

    releaseExecution?.();
    const result = await resultPromise;

    expect(result).toEqual({
      targetId: 'proxy-openai-responses',
      apiProtocol: 'openai-responses',
      success: false,
      failure: { kind: 'timeout' },
    });
    expectNoSecrets(result);
  });

  it('returns only structural success evidence', async () => {
    const target = createAIIntegrationSchedule(proxyEnvironment())[0];
    let signal: AbortSignal | undefined;

    const result = await runAIIntegrationTarget(target, {
      execute: async (_target, abortSignal) => {
        signal = abortSignal;
        return 'tool-call';
      },
    });

    expect(result).toEqual({
      targetId: 'proxy-openai-responses',
      apiProtocol: 'openai-responses',
      success: true,
      evidence: 'tool-call',
    });
    expect(signal?.aborted).toBe(true);
    expectNoSecrets(result);
  });

  it('reduces arbitrary stream errors to a fixed category', () => {
    const failure = sanitizeAIIntegrationFailure(
      Object.assign(new Error(secrets.rawError), {
        endpoint: secrets.openAIEndpoint,
        apiKey: secrets.apiKey,
      }),
      { phase: 'stream' }
    );

    expect(failure).toEqual({ kind: 'stream' });
    expectNoSecrets(failure);
  });
});
