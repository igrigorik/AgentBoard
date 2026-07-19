import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { JSONValue, LanguageModel } from 'ai';
import type { AgentConfig } from '../storage/config';
import type { ApiProtocol } from './protocol';

export type ProviderOptions = Record<string, Record<string, JSONValue>>;

export interface ModelRuntime {
  apiProtocol: ApiProtocol;
  model: LanguageModel;
  providerOptions?: ProviderOptions;
}

function buildOpenAIResponsesOptions(agent: AgentConfig): ProviderOptions {
  const options: Record<string, JSONValue> = { store: false };
  const reasoning = agent.reasoning?.enabled ? agent.reasoning.openai : undefined;

  if (reasoning) {
    options.reasoningEffort = reasoning.reasoningEffort;
    if (reasoning.reasoningSummary) {
      options.reasoningSummary = reasoning.reasoningSummary;
    }
  }

  return { openai: options };
}

function buildOpenAIChatOptions(agent: AgentConfig): ProviderOptions | undefined {
  const reasoning = agent.reasoning?.enabled ? agent.reasoning.openai : undefined;
  if (!reasoning) return undefined;

  return {
    openai: {
      reasoningEffort: reasoning.reasoningEffort,
    },
  };
}

function buildAnthropicOptions(agent: AgentConfig): ProviderOptions | undefined {
  const reasoning = agent.reasoning?.enabled ? agent.reasoning.anthropic : undefined;
  if (!reasoning) return undefined;

  return {
    anthropic: {
      thinking: {
        type: 'enabled',
        budgetTokens: reasoning.thinkingBudgetTokens || 12000,
      },
    },
  };
}

function buildGoogleOptions(agent: AgentConfig): ProviderOptions | undefined {
  const reasoning = agent.reasoning?.enabled ? agent.reasoning.google : undefined;
  if (!reasoning) return undefined;

  return {
    google: {
      thinkingConfig: {
        thinkingBudget: reasoning.thinkingBudget ?? 8192,
        includeThoughts: reasoning.includeThoughts ?? true,
      },
    },
  };
}

/**
 * Construct the SDK model and protocol-owned request options without issuing a
 * request. The exhaustive switch is the only transport-selection authority.
 */
export function createModelRuntime(agent: AgentConfig): ModelRuntime {
  switch (agent.apiProtocol) {
    case 'openai-responses': {
      const openai = createOpenAI({
        apiKey: agent.apiKey || 'no-key-provided',
        baseURL: agent.endpoint,
      });
      return {
        apiProtocol: agent.apiProtocol,
        model: openai.responses(agent.model),
        providerOptions: buildOpenAIResponsesOptions(agent),
      };
    }

    case 'openai-chat-completions': {
      const openai = createOpenAI({
        apiKey: agent.apiKey || 'no-key-provided',
        baseURL: agent.endpoint,
      });
      return {
        apiProtocol: agent.apiProtocol,
        model: openai.chat(agent.model),
        providerOptions: buildOpenAIChatOptions(agent),
      };
    }

    case 'anthropic-messages': {
      const anthropicConfig: Parameters<typeof createAnthropic>[0] = {
        apiKey: agent.apiKey || 'no-key-provided',
        baseURL: agent.endpoint,
      };

      // Anthropic requires this opt-in only for browser-to-provider requests.
      // A custom endpoint owns its own CORS and authentication contract.
      if (!agent.endpoint) {
        anthropicConfig.headers = {
          'anthropic-dangerous-direct-browser-access': 'true',
        };
        anthropicConfig.fetch = async (url, options) =>
          globalThis.fetch(url, {
            ...options,
            headers: {
              ...options?.headers,
              'anthropic-dangerous-direct-browser-access': 'true',
            },
          });
      }

      const anthropic = createAnthropic(anthropicConfig);
      return {
        apiProtocol: agent.apiProtocol,
        model: anthropic(agent.model),
        providerOptions: buildAnthropicOptions(agent),
      };
    }

    case 'google-generative-ai': {
      const google = createGoogleGenerativeAI({
        apiKey: agent.apiKey || 'no-key-provided',
        baseURL: agent.endpoint,
      });
      return {
        apiProtocol: agent.apiProtocol,
        model: google(agent.model),
        providerOptions: buildGoogleOptions(agent),
      };
    }
  }

  throw new Error(`Unsupported agent API protocol: ${String(agent.apiProtocol)}`);
}
