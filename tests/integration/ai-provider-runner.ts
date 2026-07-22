import { streamText, tool } from 'ai';
import { z } from 'zod';
import { createModelRuntime } from '../../src/lib/ai/model-runtime';
import type { ApiProtocol } from '../../src/lib/ai/protocol';
import type { AgentConfig } from '../../src/lib/storage/config';
import {
  AI_INTEGRATION_TARGETS,
  type AIIntegrationTargetDefinition,
  type AIIntegrationTargetId,
} from './ai-provider-targets';

const TARGETS_ENV = 'AGENTBOARD_AI_INTEGRATION_TARGETS';
const CONFIRM_REQUESTS_ENV = 'AGENTBOARD_AI_INTEGRATION_CONFIRM_REQUESTS';
const RUN_ENV = 'RUN_AGENTBOARD_AI_INTEGRATION';
const DEFAULT_TIMEOUT_MS = 30_000;

const integrationTool = tool({
  description: 'Confirm the AI integration transport',
  inputSchema: z.object({}),
});

export interface ResolvedAIIntegrationTarget {
  id: AIIntegrationTargetId;
  kind: 'direct' | 'proxy';
  apiProtocol: ApiProtocol;
  provider: AgentConfig['provider'];
  endpoint?: string;
  model: string;
  apiKey: string;
}

export type AIIntegrationFailureKind =
  | 'aborted'
  | 'http'
  | 'setup'
  | 'stream'
  | 'timeout'
  | 'unexpected-response'
  | 'unknown';

export interface AIIntegrationFailure {
  kind: AIIntegrationFailureKind;
  statusCode?: number;
}

export type AIIntegrationResult =
  | {
      targetId: AIIntegrationTargetId;
      apiProtocol: ApiProtocol;
      success: true;
      evidence: 'tool-call';
    }
  | {
      targetId: AIIntegrationTargetId;
      apiProtocol: ApiProtocol;
      success: false;
      failure: AIIntegrationFailure;
    };

class IntegrationConfigurationError extends Error {}
class IntegrationTimeoutError extends Error {}
class IntegrationExecutionError extends Error {
  constructor(readonly failure: AIIntegrationFailure) {
    super('AI integration execution failed');
  }
}

function requiredEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value)
    throw new IntegrationConfigurationError(`Missing required environment variable: ${name}`);
  return value;
}

function resolveTarget(
  id: AIIntegrationTargetId,
  definition: AIIntegrationTargetDefinition,
  env: NodeJS.ProcessEnv
): ResolvedAIIntegrationTarget {
  const model = requiredEnvironmentValue(env, definition.modelEnv);
  let endpoint: string | undefined;

  if (definition.baseUrlEnv) {
    endpoint = requiredEnvironmentValue(env, definition.baseUrlEnv);
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      throw new IntegrationConfigurationError(
        `Invalid URL in environment variable: ${definition.baseUrlEnv}`
      );
    }
    if (parsedEndpoint.protocol !== 'https:') {
      throw new IntegrationConfigurationError(
        `Integration endpoint must use HTTPS: ${definition.baseUrlEnv}`
      );
    }
  }

  const apiKey = requiredEnvironmentValue(env, definition.apiKeyEnv);

  return {
    id,
    kind: definition.kind,
    apiProtocol: definition.apiProtocol,
    provider: definition.provider,
    endpoint,
    model,
    apiKey,
  };
}

/** Resolve and validate the complete paid request schedule before any model is constructed. */
export function createAIIntegrationSchedule(
  env: NodeJS.ProcessEnv = process.env
): ResolvedAIIntegrationTarget[] {
  const requestedTargets = requiredEnvironmentValue(env, TARGETS_ENV)
    .split(',')
    .map((target) => target.trim())
    .filter(Boolean);

  if (requestedTargets.length === 0) {
    throw new IntegrationConfigurationError('At least one AI integration target is required');
  }
  if (new Set(requestedTargets).size !== requestedTargets.length) {
    throw new IntegrationConfigurationError('Integration target IDs must be unique');
  }

  const confirmedRequests = Number(requiredEnvironmentValue(env, CONFIRM_REQUESTS_ENV));
  if (!Number.isSafeInteger(confirmedRequests) || confirmedRequests !== requestedTargets.length) {
    throw new IntegrationConfigurationError(
      `${CONFIRM_REQUESTS_ENV} must equal the selected target count`
    );
  }

  return requestedTargets.map((requestedTarget) => {
    if (!Object.hasOwn(AI_INTEGRATION_TARGETS, requestedTarget)) {
      throw new IntegrationConfigurationError('Unknown AI integration target ID');
    }
    const id = requestedTarget as AIIntegrationTargetId;
    return resolveTarget(id, AI_INTEGRATION_TARGETS[id], env);
  });
}

export function shouldRunAIIntegration(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RUN_ENV] === '1';
}

function numericStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  const status = record.statusCode ?? record.status;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

export function sanitizeAIIntegrationFailure(
  error: unknown,
  options: { timedOut?: boolean; phase?: 'setup' | 'stream' } = {}
): AIIntegrationFailure {
  if (error instanceof IntegrationExecutionError) return error.failure;
  if (options.timedOut || error instanceof IntegrationTimeoutError) return { kind: 'timeout' };

  const statusCode = numericStatus(error);
  if (statusCode !== undefined) return { kind: 'http', statusCode };

  if (error instanceof Error && error.name === 'AbortError') return { kind: 'aborted' };
  if (options.phase === 'setup') return { kind: 'setup' };
  if (options.phase === 'stream') return { kind: 'stream' };
  return { kind: 'unknown' };
}

async function executeAIIntegrationTarget(
  target: ResolvedAIIntegrationTarget,
  abortSignal: AbortSignal
): Promise<'tool-call'> {
  const agent: AgentConfig = {
    id: `integration-${target.id}`,
    name: target.id,
    provider: target.provider,
    apiKey: target.apiKey,
    model: target.model,
    endpoint: target.endpoint,
    apiProtocol: target.apiProtocol,
    systemPrompt: '',
    temperature: 0.7,
  };
  const runtime = createModelRuntime(agent);
  let streamFailure: AIIntegrationFailure | undefined;

  const result = streamText({
    model: runtime.model,
    providerOptions: runtime.providerOptions,
    messages: [
      {
        role: 'user',
        content: 'Call integration_ok exactly once with an empty object.',
      },
    ],
    tools: { integration_ok: integrationTool },
    toolChoice: { type: 'tool', toolName: 'integration_ok' },
    maxRetries: 0,
    abortSignal,
    onError: ({ error }) => {
      streamFailure = sanitizeAIIntegrationFailure(error, { phase: 'stream' });
    },
  });

  const reader = result.fullStream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === 'tool-call' && value.toolName === 'integration_ok') return 'tool-call';
      if (value.type === 'error') {
        throw new IntegrationExecutionError(
          sanitizeAIIntegrationFailure(value.error, { phase: 'stream' })
        );
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (streamFailure) throw new IntegrationExecutionError(streamFailure);
  throw new IntegrationExecutionError({ kind: 'unexpected-response' });
}

export async function runAIIntegrationTarget(
  target: ResolvedAIIntegrationTarget,
  options: {
    timeoutMs?: number;
    execute?: (
      target: ResolvedAIIntegrationTarget,
      abortSignal: AbortSignal
    ) => Promise<'tool-call'>;
  } = {}
): Promise<AIIntegrationResult> {
  const controller = new AbortController();
  const execute = options.execute ?? executeAIIntegrationTarget;
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const execution = Promise.resolve().then(() => execute(target, controller.signal));

  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        reject(new IntegrationTimeoutError('AI integration request timed out'));
        controller.abort();
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    });

    const evidence = await Promise.race([execution, timeout]);
    return {
      targetId: target.id,
      apiProtocol: target.apiProtocol,
      success: true,
      evidence,
    };
  } catch (error) {
    // Never advance the paid schedule while an aborted request is still settling.
    // If a provider ignores abort, the enclosing integration test times out and stops.
    if (timedOut) await execution.catch(() => undefined);

    return {
      targetId: target.id,
      apiProtocol: target.apiProtocol,
      success: false,
      failure: sanitizeAIIntegrationFailure(error, { timedOut, phase: 'stream' }),
    };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    controller.abort();
  }
}

export function formatAIIntegrationPreflight(
  schedule: readonly ResolvedAIIntegrationTarget[]
): string {
  return JSON.stringify({
    mode: 'preflight',
    requestCount: schedule.length,
    targets: schedule.map(({ id, apiProtocol }) => ({ id, apiProtocol })),
  });
}

export function formatAIIntegrationSummary(options: {
  commit: string;
  timestamp: string;
  results: readonly AIIntegrationResult[];
}): string {
  return JSON.stringify({
    mode: 'integration',
    commit: options.commit,
    timestamp: options.timestamp,
    requestCount: options.results.length,
    results: options.results,
  });
}
