import type { AIProvider } from './config';
import { isApiProtocol, type ApiProtocol } from '../ai/protocol';

const KNOWN_PROVIDERS: readonly AIProvider[] = ['openai', 'anthropic', 'google'];

function isKnownProvider(value: unknown): value is AIProvider {
  return typeof value === 'string' && KNOWN_PROVIDERS.includes(value as AIProvider);
}

function nativeProtocol(provider: AIProvider): ApiProtocol {
  switch (provider) {
    case 'openai':
      return 'openai-responses';
    case 'anthropic':
      return 'anthropic-messages';
    case 'google':
      return 'google-generative-ai';
  }
}

/**
 * Preserve the endpoint classifier released with schema v1. Its ordering is
 * intentionally frozen here so future runtime routing cannot inherit or amend it.
 */
function inferLegacyEndpointProtocol(endpoint: string, provider: AIProvider): ApiProtocol {
  const normalizedEndpoint = endpoint.toLowerCase();

  if (normalizedEndpoint.includes('/v1')) return 'openai-chat-completions';

  if (
    normalizedEndpoint.includes('/vendors/') ||
    normalizedEndpoint.includes('anthropic.com') ||
    normalizedEndpoint.includes('googleapis.com')
  ) {
    return nativeProtocol(provider);
  }

  return 'openai-chat-completions';
}

/**
 * Normalize a persisted v1 or v2 agent into the explicit v2 runtime contract.
 * This function is pure, deterministic, and network-free. It validates only the
 * fields that can influence transport; complete config validation belongs at the
 * schema-v2 storage/import boundary.
 */
export function migrateAgentToV2(agent: unknown): Record<string, unknown> {
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) {
    throw new Error('Invalid agent configuration');
  }

  const record = agent as Record<string, unknown>;

  if (!isKnownProvider(record.provider)) {
    throw new Error('Invalid or missing agent provider');
  }

  if (typeof record.model !== 'string' || record.model.trim() === '') {
    throw new Error('Invalid or missing agent model');
  }

  if (record.endpoint !== undefined && typeof record.endpoint !== 'string') {
    throw new Error('Invalid agent endpoint');
  }

  if (record.openaiCompatible !== undefined && typeof record.openaiCompatible !== 'boolean') {
    throw new Error('Invalid legacy OpenAI compatibility setting');
  }

  let apiProtocol: ApiProtocol;

  if (record.apiProtocol !== undefined) {
    if (!isApiProtocol(record.apiProtocol)) {
      throw new Error('Invalid agent API protocol');
    }
    if (record.openaiCompatible !== undefined) {
      throw new Error('Agent configuration contains conflicting protocol settings');
    }
    apiProtocol = record.apiProtocol;
  } else if (record.openaiCompatible === true) {
    apiProtocol = 'openai-chat-completions';
  } else if (record.openaiCompatible === false) {
    apiProtocol = nativeProtocol(record.provider);
  } else if (record.endpoint) {
    apiProtocol = inferLegacyEndpointProtocol(record.endpoint, record.provider);
  } else {
    apiProtocol = nativeProtocol(record.provider);
  }

  const migrated: Record<string, unknown> = { ...record, apiProtocol };
  delete migrated.openaiCompatible;
  return migrated;
}
