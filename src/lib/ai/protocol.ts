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

/** Derive descriptive API-family metadata from the explicit transport contract. */
export function providerForApiProtocol(protocol: ApiProtocol): 'openai' | 'anthropic' | 'google' {
  switch (protocol) {
    case 'openai-responses':
    case 'openai-chat-completions':
      return 'openai';
    case 'anthropic-messages':
      return 'anthropic';
    case 'google-generative-ai':
      return 'google';
  }
}
