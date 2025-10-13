/**
 * Backup & Restore functionality
 * Handles exporting/importing all extension settings
 */

import log from '../lib/logger';
import { ConfigStorage } from '../lib/storage/config';
import type { StorageConfig } from '../lib/storage/config';
import type { CommandStorage } from '../types';

// Backup format version for compatibility checking
const BACKUP_VERSION = '1.0';

interface BackupData {
  version: string;
  extensionVersion: string;
  timestamp: number;
  exportedBy: string;
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
    showStatus('Importing settings...', 'info');

    // Read file
    const content = await readFile(file);
    const backupData: BackupData = JSON.parse(content);

    // Validate format
    if (backupData.version !== BACKUP_VERSION) {
      throw new Error(
        `Incompatible backup version: ${backupData.version} (expected ${BACKUP_VERSION})`
      );
    }

    // Validate structure
    validateBackupStructure(backupData);

    // Apply atomically (all or nothing)
    await applyBackup(backupData);

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
async function gatherBackupData(): Promise<BackupData> {
  // Get config from local storage
  const config = await configStorage.get();

  // Get commands from local storage
  const commandsResult = await chrome.storage.local.get('slashCommands');
  const commands: CommandStorage = commandsResult.slashCommands || { userCommands: [] };

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

/**
 * Validate backup data structure
 */
function validateBackupStructure(data: BackupData): void {
  // Check required top-level fields
  if (!data.version || !data.config || !data.commands) {
    throw new Error('Invalid backup structure: missing required fields');
  }

  // Check config structure
  if (!Array.isArray(data.config.agents)) {
    throw new Error('Invalid backup: config.agents must be an array');
  }

  // Check commands structure
  if (!Array.isArray(data.commands.userCommands)) {
    throw new Error('Invalid backup: commands.userCommands must be an array');
  }
}

/**
 * Apply backup data atomically
 */
async function applyBackup(data: BackupData): Promise<void> {
  try {
    // Clear existing storage
    await chrome.storage.local.clear();

    // Restore config
    await chrome.storage.local.set({
      config: data.config,
    });

    // Restore commands
    await chrome.storage.local.set({
      slashCommands: data.commands,
    });

    log.info('[Backup] Successfully restored settings');
  } catch (error) {
    log.error('[Backup] Failed to apply backup:', error);
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
