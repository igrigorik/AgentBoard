/**
 * Centralized logging module using loglevel
 * Provides consistent log level management across all extension contexts
 *
 * Design decisions:
 * - Single global logger (no namespacing) for simplicity
 * - Two-phase initialization: sync default -> async storage override
 * - Default level: 'warn' to balance feedback vs noise
 * - User-configurable via Options UI, stored in chrome.storage
 * - All contexts (background, sidebar, options, content scripts) respect same level
 */

import log from 'loglevel';

// Detect test environment - Vitest sets process.env.NODE_ENV and global test context
const isTestEnvironment =
  (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') ||
  (typeof globalThis !== 'undefined' && 'vitest' in globalThis);

// Default log level - applied synchronously on import to capture early logs
// Silent in tests to avoid noise, warn in production for useful feedback
const DEFAULT_LOG_LEVEL = isTestEnvironment ? 'silent' : 'warn';

// Initialize with default immediately (synchronous)
log.setLevel(DEFAULT_LOG_LEVEL as log.LogLevelDesc);

// Phase 2: Override from storage asynchronously
// This runs ASAP after import, updates level if user has configured it
// Guard against test environments where chrome APIs may not be fully mocked
if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
  chrome.storage.local.get(['config'], (result) => {
    if (result.config?.logLevel) {
      try {
        log.setLevel(result.config.logLevel as log.LogLevelDesc);
      } catch (error) {
        console.error('[Logger] Invalid log level in storage:', result.config.logLevel, error);
      }
    }
  });
}

// Phase 3: Listen for real-time changes from Options UI
// Only set up listener if chrome.storage.onChanged is available
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged?.addListener) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.config?.newValue?.logLevel) {
      try {
        log.setLevel(changes.config.newValue.logLevel as log.LogLevelDesc);
      } catch (error) {
        console.error(
          '[Logger] Invalid log level in update:',
          changes.config.newValue.logLevel,
          error
        );
      }
    }
  });
}

// Export configured logger
export default log;
