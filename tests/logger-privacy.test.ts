import { readFileSync } from 'node:fs';
import { generateText } from 'ai';
import * as ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const baseLogger = vi.hoisted(() => ({
  setLevel: vi.fn(),
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('loglevel', () => ({ default: baseLogger }));

import log from '../src/lib/logger';
import '../src/lib/ai/client';

describe('privacy-preserving logger boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('discards arbitrary caller context before writing to the console logger', () => {
    const secret = 'credential-and-provider-response';

    log.trace(secret, { prompt: secret });
    log.debug(`endpoint=${secret}`);
    log.info('request', { headers: { authorization: secret } });
    log.warn('tool result', secret);
    log.error(new Error(secret), { response: secret });

    expect(baseLogger.trace).toHaveBeenCalledWith('[AgentBoard] Trace event');
    expect(baseLogger.debug).toHaveBeenCalledWith('[AgentBoard] Debug event');
    expect(baseLogger.info).toHaveBeenCalledWith('[AgentBoard] Information event');
    expect(baseLogger.warn).toHaveBeenCalledWith('[AgentBoard] Warning event');
    expect(baseLogger.error).toHaveBeenCalledWith('[AgentBoard] Operation failed');
    expect(JSON.stringify(baseLogger.trace.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(baseLogger.debug.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(baseLogger.info.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(baseLogger.warn.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(baseLogger.error.mock.calls)).not.toContain(secret);
  });

  it('suppresses dependency-owned AI SDK warnings', async () => {
    const secret = 'secret-model-or-tool-value';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const model = {
      specificationVersion: 'v2',
      provider: 'privacy-test',
      modelId: secret,
      supportedUrls: {},
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [{ type: 'other', message: secret }],
      }),
      doStream: async () => {
        throw new Error('not used');
      },
    };

    const result = await generateText({ model: model as never, prompt: 'test' });

    expect(result.warnings).toEqual([{ type: 'other', message: secret }]);
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    warn.mockRestore();
    info.mockRestore();
  });

  it('keeps page-facing console diagnostics to one fixed literal', () => {
    const files = [
      'src/content-scripts/page-bridge.js',
      'src/content-scripts/relay.js',
      'src/content-scripts/webmcp-polyfill.js',
      'src/lib/webmcp/script-injector.ts',
    ];

    for (const file of files) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'console'
        ) {
          expect(node.arguments, file).toHaveLength(1);
          expect(ts.isStringLiteralLike(node.arguments[0]), file).toBe(true);
        }
        ts.forEachChild(node, visit);
      };

      visit(source);
    }
  });
});
