/**
 * Backup & Restore functionality
 * Handles exporting/importing all extension settings
 */

import log from '../lib/logger';
import { ConfigStorage, parseStorageConfig, type StorageConfig } from '../lib/storage/config';
import { validateCommandStorage } from '../lib/commands/storage';
import { runStorageOperation } from '../lib/storage/operation-queue';
import type { CommandStorage } from '../types';

export const BACKUP_VERSION = '2.0' as const;
const LEGACY_BACKUP_VERSION = '1.0' as const;

interface BackupData {
  version: typeof BACKUP_VERSION;
  extensionVersion: string;
  timestamp: number;
  exportedBy: 'AgentBoard';
  config: StorageConfig;
  commands: CommandStorage;
}

export interface PreparedBackup {
  config: StorageConfig;
  commands: CommandStorage;
}

const configStorage = ConfigStorage.getInstance();

/**
 * Initialize backup/restore UI
 */
export async function initializeBackupRestore(): Promise<void> {
  const exportBtn = document.getElementById('export-settings');
  const importBtn = document.getElementById('import-settings');
  const fileInput = document.getElementById('import-file-input') as HTMLInputElement;

  if (!exportBtn || !importBtn || !fileInput) {
    log.warn('[Backup] UI elements not found, skipping initialization');
    return;
  }

  // Export button
  exportBtn.addEventListener('click', exportSettings);

  // Import button triggers file picker
  importBtn.addEventListener('click', () => {
    fileInput.click();
  });

  // File input handles actual import
  fileInput.addEventListener('change', async (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (file) {
      await importSettings(file);
      // Clear input so same file can be selected again
      input.value = '';
    }
  });
}

/**
 * Export all settings to a JSON file
 */
export async function exportSettings(): Promise<void> {
  try {
    showStatus('Exporting settings...', 'info');

    // Gather all data
    const backupData = await gatherBackupData();

    // Download as JSON file
    downloadBackupFile(backupData);

    showStatus('Settings exported successfully!', 'success');
  } catch (error) {
    log.error('[Backup] Export failed:', error);
    showStatus('Failed to export settings', 'error');
  }
}

/**
 * Import settings from a JSON file
 */
export async function importSettings(file: File): Promise<void> {
  try {
    showStatus('Validating backup...', 'info');

    const content = await readFile(file);
    const prepared = prepareBackupImport(JSON.parse(content) as unknown);

    showStatus('Importing settings...', 'info');
    await applyPreparedBackup(prepared);

    // Success
    showStatus('Settings imported successfully! Reloading...', 'success');

    // Reload page to reflect changes
    setTimeout(() => {
      window.location.reload();
    }, 1500);
  } catch (error) {
    log.error('[Backup] Import failed:', error);

    if (error instanceof SyntaxError) {
      showStatus('Invalid backup file: not valid JSON', 'error');
    } else if (error instanceof Error) {
      showStatus(`Import failed: ${error.message}`, 'error');
    } else {
      showStatus('Import failed: Unknown error', 'error');
    }
  }
}

/**
 * Gather all data to backup
 */
export async function gatherBackupData(): Promise<BackupData> {
  // Read both keys under the same queue so import cannot split the export snapshot.
  const { config, values } = await configStorage.getSnapshot(['slashCommands']);
  const commands =
    values.slashCommands === undefined
      ? { userCommands: [] }
      : validateCommandStorage(values.slashCommands);

  // Get extension version from manifest
  const manifest = chrome.runtime.getManifest();

  return {
    version: BACKUP_VERSION,
    extensionVersion: manifest.version,
    timestamp: Date.now(),
    exportedBy: 'AgentBoard',
    config,
    commands,
  };
}

function backupRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid backup structure');
  }
  return value as Record<string, unknown>;
}

/** Validate and migrate the complete backup before the first storage mutation. */
export function prepareBackupImport(value: unknown): PreparedBackup {
  const backup = backupRecord(value);
  if (
    typeof backup.extensionVersion !== 'string' ||
    typeof backup.timestamp !== 'number' ||
    !Number.isFinite(backup.timestamp) ||
    backup.timestamp < 0 ||
    backup.exportedBy !== 'AgentBoard'
  ) {
    throw new Error('Invalid backup structure');
  }

  if (backup.version !== LEGACY_BACKUP_VERSION && backup.version !== BACKUP_VERSION) {
    throw new Error('Unsupported backup version');
  }

  const parsed = parseStorageConfig(backup.config);
  if (backup.version === LEGACY_BACKUP_VERSION && !parsed.migrated) {
    throw new Error('Invalid legacy backup configuration');
  }
  if (backup.version === BACKUP_VERSION && parsed.migrated) {
    throw new Error('Invalid current backup configuration');
  }

  const commands = validateCommandStorage(backup.commands);
  return { config: parsed.config, commands };
}

/**
 * Chrome storage has no transaction API. One validated two-key set is the
 * narrowest commit boundary and avoids the destructive empty-state window.
 */
export async function applyPreparedBackup(data: PreparedBackup): Promise<void> {
  try {
    const snapshot = globalThis.structuredClone(data);
    await runStorageOperation(async () => {
      // Revalidate inside the shared mutation queue, immediately before the one
      // combined write, so no stale config mutation can overtake this commit.
      const parsed = parseStorageConfig(snapshot.config);
      if (parsed.migrated) throw new Error('Invalid prepared backup configuration');
      const commands = validateCommandStorage(snapshot.commands);
      await chrome.storage.local.set({
        config: parsed.config,
        slashCommands: commands,
      });
    });
    log.info('[Backup] Successfully restored settings');
  } catch {
    log.error('[Backup] Failed to apply validated backup');
    throw new Error('Failed to save restored settings');
  }
}

/**
 * Download backup data as JSON file
 */
function downloadBackupFile(data: BackupData): void {
  // Create JSON blob
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  // Generate filename with date and time
  const now = new Date();
  const date = now.toISOString().split('T')[0]; // 2025-01-08
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const filename = `agentboard-backup-${date}-${hours}-${minutes}.json`;

  // Trigger download
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();

  // Cleanup
  URL.revokeObjectURL(url);
}

/**
 * Read file as text
 */
function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

/**
 * Show status message to user
 */
function showStatus(message: string, type: 'success' | 'error' | 'info'): void {
  const statusEl = document.getElementById('status-message');
  if (!statusEl) return;

  statusEl.textContent = message;
  statusEl.className = `status-message ${type}`;
  statusEl.style.display = 'block';

  // Auto-hide after delay
  const delay = type === 'error' ? 5000 : 3000;
  setTimeout(() => {
    statusEl.style.display = 'none';
  }, delay);
}
