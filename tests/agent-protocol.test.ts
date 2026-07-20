import { describe, expect, it } from 'vitest';
import { providerForApiProtocol } from '../src/lib/ai/protocol';
import { protocolBadgeLabel, protocolForConnectionApi } from '../src/options/agent-protocol';

const protocols = [
  {
    protocol: 'openai-responses' as const,
    connectionApi: 'openai' as const,
    badge: 'OpenAI-style · Responses',
  },
  {
    protocol: 'openai-chat-completions' as const,
    connectionApi: 'openai' as const,
    badge: 'OpenAI-style · Legacy Chat',
  },
  {
    protocol: 'anthropic-messages' as const,
    connectionApi: 'anthropic' as const,
    badge: 'Anthropic',
  },
  {
    protocol: 'google-generative-ai' as const,
    connectionApi: 'google' as const,
    badge: 'Google Generative AI',
  },
] as const;

describe('Connection API presentation', () => {
  it.each(protocols)(
    'renders and derives $protocol without model or endpoint inference',
    (entry) => {
      expect(providerForApiProtocol(entry.protocol)).toBe(entry.connectionApi);
      expect(protocolBadgeLabel(entry.protocol)).toBe(entry.badge);
    }
  );

  it('defaults new OpenAI-style selections to Responses', () => {
    expect(protocolForConnectionApi('openai')).toBe('openai-responses');
  });

  it('preserves an explicit legacy Chat selection', () => {
    expect(protocolForConnectionApi('openai', 'openai-chat-completions')).toBe(
      'openai-chat-completions'
    );
  });

  it('maps native APIs without an OpenAI mode', () => {
    expect(protocolForConnectionApi('anthropic')).toBe('anthropic-messages');
    expect(protocolForConnectionApi('google')).toBe('google-generative-ai');
  });
});
