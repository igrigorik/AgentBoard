/**
 * Centralized logging module using loglevel.
 * Configuration is applied only after the complete AgentBoard record validates;
 * malformed/future records must not enable verbose logging as a side effect.
 */

import log from 'loglevel';
import { parseStorageConfig, type LogLevel, type StorageConfig } from '../storage/config';

const isTestEnvironment =
  (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') ||
  (typeof globalThis !== 'undefined' && 'vitest' in globalThis);
const DEFAULT_LOG_LEVEL: LogLevel = isTestEnvironment ? 'silent' : 'warn';

function applyLogLevel(config: StorageConfig): void {
  log.setLevel(config.logLevel ?? DEFAULT_LOG_LEVEL);
}

function rejectLogLevel(): void {
  log.setLevel(DEFAULT_LOG_LEVEL);
  console.error('[Logger] Ignoring invalid stored configuration');
}

function applyStoredConfig(value: unknown): void {
  if (value === undefined) {
    log.setLevel(DEFAULT_LOG_LEVEL);
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

log.setLevel(DEFAULT_LOG_LEVEL);

if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
  chrome.storage.local.get(['config'], (result) => applyStoredConfig(result.config));
}

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged?.addListener) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.config) applyStoredConfig(changes.config.newValue);
  });
}

export default log;
