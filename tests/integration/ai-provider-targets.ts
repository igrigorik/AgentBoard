import type { AIProvider } from '../../src/lib/storage/config';
import type { ApiProtocol } from '../../src/lib/ai/protocol';

export interface AIIntegrationTargetDefinition {
  kind: 'direct' | 'proxy';
  apiProtocol: ApiProtocol;
  provider: AIProvider;
  baseUrlEnv?: string;
  modelEnv: string;
  apiKeyEnv: string;
}

/**
 * Fixed target IDs keep the paid request schedule reviewable. Environment
 * variables hold every endpoint, model, and credential value.
 */
export const AI_INTEGRATION_TARGETS = {
  'proxy-openai-responses': {
    kind: 'proxy',
    apiProtocol: 'openai-responses',
    provider: 'openai',
    baseUrlEnv: 'AGENTBOARD_AI_INTEGRATION_PROXY_OPENAI_BASE_URL',
    modelEnv: 'AGENTBOARD_AI_INTEGRATION_PROXY_RESPONSES_MODEL',
    apiKeyEnv: 'AGENTBOARD_AI_INTEGRATION_PROXY_KEY',
  },
  'proxy-openai-chat': {
    kind: 'proxy',
    apiProtocol: 'openai-chat-completions',
    provider: 'openai',
    baseUrlEnv: 'AGENTBOARD_AI_INTEGRATION_PROXY_OPENAI_BASE_URL',
    modelEnv: 'AGENTBOARD_AI_INTEGRATION_PROXY_CHAT_MODEL',
    apiKeyEnv: 'AGENTBOARD_AI_INTEGRATION_PROXY_KEY',
  },
  'proxy-anthropic-messages': {
    kind: 'proxy',
    apiProtocol: 'anthropic-messages',
    provider: 'anthropic',
    baseUrlEnv: 'AGENTBOARD_AI_INTEGRATION_PROXY_ANTHROPIC_BASE_URL',
    modelEnv: 'AGENTBOARD_AI_INTEGRATION_PROXY_ANTHROPIC_MODEL',
    apiKeyEnv: 'AGENTBOARD_AI_INTEGRATION_PROXY_KEY',
  },
  'direct-openai-responses': {
    kind: 'direct',
    apiProtocol: 'openai-responses',
    provider: 'openai',
    modelEnv: 'AGENTBOARD_AI_INTEGRATION_DIRECT_OPENAI_MODEL',
    apiKeyEnv: 'AGENTBOARD_AI_INTEGRATION_DIRECT_OPENAI_KEY',
  },
  'direct-anthropic-messages': {
    kind: 'direct',
    apiProtocol: 'anthropic-messages',
    provider: 'anthropic',
    modelEnv: 'AGENTBOARD_AI_INTEGRATION_DIRECT_ANTHROPIC_MODEL',
    apiKeyEnv: 'AGENTBOARD_AI_INTEGRATION_DIRECT_ANTHROPIC_KEY',
  },
  'direct-google-generative-ai': {
    kind: 'direct',
    apiProtocol: 'google-generative-ai',
    provider: 'google',
    modelEnv: 'AGENTBOARD_AI_INTEGRATION_DIRECT_GOOGLE_MODEL',
    apiKeyEnv: 'AGENTBOARD_AI_INTEGRATION_DIRECT_GOOGLE_KEY',
  },
} as const satisfies Record<string, AIIntegrationTargetDefinition>;

export type AIIntegrationTargetId = keyof typeof AI_INTEGRATION_TARGETS;
