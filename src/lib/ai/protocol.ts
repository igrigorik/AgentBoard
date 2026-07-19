export const API_PROTOCOLS = [
  'openai-responses',
  'openai-chat-completions',
  'anthropic-messages',
  'google-generative-ai',
] as const;

export type ApiProtocol = (typeof API_PROTOCOLS)[number];

export function isApiProtocol(value: unknown): value is ApiProtocol {
  return typeof value === 'string' && API_PROTOCOLS.includes(value as ApiProtocol);
}

export function isOpenAIProtocol(protocol: ApiProtocol): boolean {
  return protocol === 'openai-responses' || protocol === 'openai-chat-completions';
}
