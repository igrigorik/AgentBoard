import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogLevel, StorageConfig } from '../src/lib/storage/config';

const baseLogger = vi.hoisted(() => ({
  setLevel: vi.fn(),
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('loglevel', () => ({ default: baseLogger }));

const apiKey = 'sk-configured-1234567890';
const mcpToken = 'configured-mcp-token-1234567890';

function storedConfig(logLevel: LogLevel): StorageConfig {
  return {
    schemaVersion: 2,
    agents: [
      {
        id: 'agent-1',
        name: 'Debug Agent',
        provider: 'openai',
        apiKey,
        model: 'debug-model',
        endpoint: 'https://api.example.test/v1',
        apiProtocol: 'openai-responses',
        temperature: 0.7,
      },
    ],
    mcpConfig: {
      mcpServers: {
        local: {
          transport: 'http',
          url: 'https://mcp.example.test',
          authToken: mcpToken,
        },
      },
    },
    logLevel,
  };
}

function returnStoredConfig(config: StorageConfig): void {
  vi.mocked(chrome.storage.local.get).mockImplementation(((_keys, callback) => {
    const result = { config };
    callback?.(result as never);
    return Promise.resolve(result);
  }) as typeof chrome.storage.local.get);
}

describe('contextual debug logger', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it.each(['debug', 'trace'] as const)(
    'retains useful context at %s while redacting credentials',
    async (logLevel) => {
      returnStoredConfig(storedConfig(logLevel));
      const log = (await import('../src/lib/logger')).default;
      const error = new Error(`Provider failed with Bearer ${apiKey}`);
      error.stack = `Error: Provider failed with Bearer ${apiKey}\n    at sendRequest (chrome-extension://test/background.js:1:2)`;

      log.error('[AI] Stream failed:', error, {
        endpoint: 'https://api.example.test/v1',
        model: 'debug-model',
        apiKey,
        headers: { authorization: `Bearer ${mcpToken}` },
        serverReply: `credential=${mcpToken}`,
      });

      expect(baseLogger.error).toHaveBeenCalledTimes(1);
      const call = baseLogger.error.mock.calls[0];
      const rendered = JSON.stringify(call);
      expect(call[0]).toBe('[AgentBoard]');
      expect(rendered).toContain('[AI] Stream failed:');
      expect(rendered).toContain('https://api.example.test/v1');
      expect(rendered).toContain('debug-model');
      expect(rendered).toContain('sendRequest');
      expect(rendered).toContain('[REDACTED]');
      expect(rendered).not.toContain(apiKey);
      expect(rendered).not.toContain(mcpToken);
    }
  );

  it('redacts credential-shaped fields and common inline key formats', async () => {
    returnStoredConfig(storedConfig('debug'));
    const log = (await import('../src/lib/logger')).default;
    const openAIKey = 'sk-proj-abcdefghijklmnopqrstuv';
    const googleKey = 'AIzaabcdefghijklmnopqrstuvwxyz123456';
    const privateKey = 'private-key-value';
    const sessionToken = 'session-token-value';
    const plainPassword = 'plain-password-value';
    const plainAuthorization = 'plain-authorization-value';

    log.debug('Connection details', {
      endpoint: 'https://api.example.test/v1',
      password: 'password-value',
      privateKey,
      sessionToken,
      nested: {
        'x-api-key': 'header-api-key',
        cookie: 'session=cookie-value',
      },
      errorText: `{"apiKey":"${openAIKey}","password":"${plainPassword}","authorization":"${plainAuthorization}"} client_secret=${googleKey} Basic basic-value`,
    });

    const rendered = JSON.stringify(baseLogger.debug.mock.calls[0]);
    expect(rendered).toContain('https://api.example.test/v1');
    expect(rendered).toContain('[REDACTED]');
    expect(rendered).not.toContain('password-value');
    expect(rendered).not.toContain(privateKey);
    expect(rendered).not.toContain(sessionToken);
    expect(rendered).not.toContain(plainPassword);
    expect(rendered).not.toContain(plainAuthorization);
    expect(rendered).not.toContain('header-api-key');
    expect(rendered).not.toContain('cookie-value');
    expect(rendered).not.toContain(openAIKey);
    expect(rendered).not.toContain(googleKey);
    expect(rendered).not.toContain('basic-value');
  });

  it('redacts short configured credentials when embedded in text', async () => {
    const config = storedConfig('debug');
    config.agents[0].apiKey = 'xy';
    returnStoredConfig(config);
    const log = (await import('../src/lib/logger')).default;

    log.debug('configured=prefix-xy-suffix');

    const rendered = JSON.stringify(baseLogger.debug.mock.calls[0]);
    expect(rendered).toContain('prefix-[REDACTED]-suffix');
    expect(rendered).not.toContain('xy');
  });

  it('keeps non-debug levels value-free', async () => {
    returnStoredConfig(storedConfig('info'));
    const log = (await import('../src/lib/logger')).default;

    log.info('endpoint=https://private.example.test', { apiKey });
    log.error('provider failure', new Error('private provider response'));

    expect(baseLogger.info).toHaveBeenCalledWith('[AgentBoard] Information event');
    expect(baseLogger.error).toHaveBeenCalledWith('[AgentBoard] Operation failed');
    expect(JSON.stringify(baseLogger.info.mock.calls)).not.toContain('private.example.test');
    expect(JSON.stringify(baseLogger.error.mock.calls)).not.toContain('private provider response');
  });

  it('handles circular debug context without throwing', async () => {
    returnStoredConfig(storedConfig('debug'));
    const log = (await import('../src/lib/logger')).default;
    const context: { label: string; self?: unknown } = { label: 'cycle preserved' };
    context.self = context;

    expect(() => log.debug('Circular context', context)).not.toThrow();
    const sanitized = baseLogger.debug.mock.calls[0][2] as typeof context;
    expect(sanitized).toEqual({ label: 'cycle preserved', self: '[Circular]' });
  });
});
