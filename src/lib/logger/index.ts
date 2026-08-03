/**
 * Application logger.
 *
 * Normal levels emit fixed messages. DEBUG and TRACE retain sanitized call-site
 * context so local DevTools can diagnose failures without exposing configured
 * AI or MCP credentials.
 */

import baseLogger from 'loglevel';
import { parseStorageConfig, type LogLevel, type StorageConfig } from '../storage/config';
import { redactDiagnosticString } from './redaction';

const isTestEnvironment =
  (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') ||
  (typeof globalThis !== 'undefined' && 'vitest' in globalThis);
const DEFAULT_LOG_LEVEL: LogLevel = isTestEnvironment ? 'silent' : 'warn';
const REDACTED_LOG_VALUE = '[REDACTED]';
const CREDENTIAL_FIELDS =
  /(?:api.?key|private.?key|authorization|token|cookie|password|secret|credential)$/i;

let activeLogLevel: LogLevel = DEFAULT_LOG_LEVEL;
let configuredSecrets: readonly string[] = [];

function collectConfiguredSecrets(config: StorageConfig): readonly string[] {
  return [
    ...new Set(
      [
        ...config.agents.map((agent) => agent.apiKey),
        ...Object.values(config.mcpConfig?.mcpServers ?? {}).map((server) => server.authToken),
      ].filter((value): value is string => Boolean(value))
    ),
  ].sort((left, right) => right.length - left.length);
}

function setLogConfiguration(level: LogLevel, secrets: readonly string[]): void {
  activeLogLevel = level;
  configuredSecrets = secrets;
  baseLogger.setLevel(level);
}

function resetLogConfiguration(): void {
  setLogConfiguration(DEFAULT_LOG_LEVEL, []);
}

function applyStoredConfig(value: unknown): void {
  if (value === undefined) {
    resetLogConfiguration();
    return;
  }
  try {
    const parsed = parseStorageConfig(value);
    // ConfigStorage owns migration. Logger stays at its safe default until the
    // resulting durable v2 storage event arrives.
    if (parsed.migrated) resetLogConfiguration();
    else {
      setLogConfiguration(
        parsed.config.logLevel ?? DEFAULT_LOG_LEVEL,
        collectConfiguredSecrets(parsed.config)
      );
    }
  } catch {
    resetLogConfiguration();
    console.error('[AgentBoard] Invalid logging configuration ignored');
  }
}

function sanitizeString(value: string): string {
  let sanitized = value;
  for (const secret of configuredSecrets) {
    sanitized = sanitized.split(secret).join(REDACTED_LOG_VALUE);
  }
  return redactDiagnosticString(sanitized);
}

function isErrorLike(
  value: unknown
): value is { name?: unknown; message: string; stack?: unknown } {
  if (!value || typeof value !== 'object') return false;
  try {
    const candidate = value as { message?: unknown; name?: unknown; stack?: unknown };
    return (
      typeof candidate.message === 'string' &&
      (typeof candidate.name === 'string' || typeof candidate.stack === 'string')
    );
  } catch {
    return false;
  }
}

function sanitizeError(error: { name?: unknown; message: string; stack?: unknown }): object {
  return {
    ...(typeof error.name === 'string' && { name: sanitizeString(error.name) }),
    message: sanitizeString(error.message),
    ...(typeof error.stack === 'string' && { stack: sanitizeString(error.stack) }),
  };
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeString(value);
  if (isErrorLike(value)) return sanitizeError(value);
  if (!value || typeof value !== 'object') return value;

  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(value, (key, current: unknown) => {
      if (key && CREDENTIAL_FIELDS.test(key.replaceAll('-', '').replaceAll('_', ''))) {
        return REDACTED_LOG_VALUE;
      }
      if (typeof current === 'string') return sanitizeString(current);
      if (typeof current === 'bigint') return `${current}n`;
      if (isErrorLike(current)) return sanitizeError(current);
      if (current && typeof current === 'object') {
        if (seen.has(current)) return '[Circular]';
        seen.add(current);
      }
      return current;
    });
    return json === undefined ? '[Unserializable context]' : JSON.parse(json);
  } catch {
    return '[Unserializable context]';
  }
}

function contextualArguments(context: unknown[], fallback: string): unknown[] {
  const detailed = activeLogLevel === 'debug' || activeLogLevel === 'trace';
  return detailed && context.length > 0
    ? ['[AgentBoard]', ...context.map(sanitizeValue)]
    : [fallback];
}

baseLogger.setLevel(DEFAULT_LOG_LEVEL);
let configChangeObserved = false;

if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
  chrome.storage.local.get(['config'], (result) => {
    if (!configChangeObserved) applyStoredConfig(result.config);
  });
}

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged?.addListener) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.config) {
      configChangeObserved = true;
      applyStoredConfig(changes.config.newValue);
    }
  });
}

type LogMethod = (...context: unknown[]) => void;

const log: Readonly<{
  trace: LogMethod;
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
}> = Object.freeze({
  trace: (...context) =>
    baseLogger.trace(...contextualArguments(context, '[AgentBoard] Trace event')),
  debug: (...context) =>
    baseLogger.debug(...contextualArguments(context, '[AgentBoard] Debug event')),
  info: (...context) =>
    baseLogger.info(...contextualArguments(context, '[AgentBoard] Information event')),
  warn: (...context) =>
    baseLogger.warn(...contextualArguments(context, '[AgentBoard] Warning event')),
  error: (...context) =>
    baseLogger.error(...contextualArguments(context, '[AgentBoard] Operation failed')),
});

export default log;
