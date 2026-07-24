/**
 * Privacy-preserving application logger.
 *
 * Callers may supply diagnostic context, but this boundary deliberately discards
 * it before reaching the browser console. Provider traffic, browser content,
 * credentials, configuration values, and arbitrary errors must never be logged.
 */

import baseLogger from 'loglevel';
import { parseStorageConfig, type LogLevel, type StorageConfig } from '../storage/config';

const isTestEnvironment =
  (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') ||
  (typeof globalThis !== 'undefined' && 'vitest' in globalThis);
const DEFAULT_LOG_LEVEL: LogLevel = isTestEnvironment ? 'silent' : 'warn';

function applyLogLevel(config: StorageConfig): void {
  baseLogger.setLevel(config.logLevel ?? DEFAULT_LOG_LEVEL);
}

function rejectLogLevel(): void {
  baseLogger.setLevel(DEFAULT_LOG_LEVEL);
  console.error('[AgentBoard] Invalid logging configuration ignored');
}

function applyStoredConfig(value: unknown): void {
  if (value === undefined) {
    baseLogger.setLevel(DEFAULT_LOG_LEVEL);
    return;
  }
  try {
    const parsed = parseStorageConfig(value);
    // ConfigStorage owns migration. Logger stays at its safe default until the
    // resulting durable v2 storage event arrives.
    if (!parsed.migrated) applyLogLevel(parsed.config);
  } catch {
    rejectLogLevel();
  }
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

type SafeLogMethod = (...discardedContext: unknown[]) => void;

/**
 * Fixed messages preserve severity and event counts without allowing call-site
 * values to escape into extension/page consoles.
 */
const log: Readonly<{
  trace: SafeLogMethod;
  debug: SafeLogMethod;
  info: SafeLogMethod;
  warn: SafeLogMethod;
  error: SafeLogMethod;
}> = Object.freeze({
  trace: () => baseLogger.trace('[AgentBoard] Trace event'),
  debug: () => baseLogger.debug('[AgentBoard] Debug event'),
  info: () => baseLogger.info('[AgentBoard] Information event'),
  warn: () => baseLogger.warn('[AgentBoard] Warning event'),
  error: () => baseLogger.error('[AgentBoard] Operation failed'),
});

export default log;
