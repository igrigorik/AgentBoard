import type { ApiProtocol } from '../lib/ai/protocol';

export type ConnectionApi = 'openai' | 'anthropic' | 'google';
export type OpenAIApiProtocol = 'openai-responses' | 'openai-chat-completions';

export function protocolForConnectionApi(
  connectionApi: ConnectionApi,
  openAIProtocol: OpenAIApiProtocol = 'openai-responses'
): ApiProtocol {
  switch (connectionApi) {
    case 'openai':
      return openAIProtocol;
    case 'anthropic':
      return 'anthropic-messages';
    case 'google':
      return 'google-generative-ai';
  }
}

export function protocolBadgeLabel(protocol: ApiProtocol): string {
  switch (protocol) {
    case 'openai-responses':
      return 'OpenAI-style · Responses';
    case 'openai-chat-completions':
      return 'OpenAI-style · Legacy Chat';
    case 'anthropic-messages':
      return 'Anthropic';
    case 'google-generative-ai':
      return 'Google Gemini';
  }
}
