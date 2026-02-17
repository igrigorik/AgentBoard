/**
 * Eval Suites management for the options page.
 * Handles importing, displaying, and deleting eval suite JSON files.
 */

import log from '../lib/logger';
import { ConfigStorage } from '../lib/storage/config';
import type { EvalSuite, StoredEvalSuite } from '../lib/eval/types';

const configStorage = ConfigStorage.getInstance();

/**
 * Initialize eval suites UI
 */
export async function initEvalSuites(): Promise<void> {
  const importBtn = document.getElementById('import-evalsuite');
  const fileInput = document.getElementById('import-evalsuite-file') as HTMLInputElement;

  if (!importBtn || !fileInput) {
    log.warn('[EvalSuites] UI elements not found, skipping initialization');
    return;
  }

  importBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', async (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (file) {
      await importEvalSuite(file);
      input.value = '';
    }
  });

  await renderEvalSuites();
}

/**
 * Render eval suite cards from storage
 */
async function renderEvalSuites(): Promise<void> {
  const listEl = document.getElementById('evalsuites-list');
  const emptyEl = document.getElementById('no-evalsuites');

  if (!listEl || !emptyEl) return;

  const suites = await configStorage.getEvalSuites();

  listEl.innerHTML = '';

  if (suites.length === 0) {
    listEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    return;
  }

  listEl.classList.remove('hidden');
  emptyEl.classList.add('hidden');

  for (const suite of suites) {
    listEl.appendChild(createSuiteCard(suite));
  }
}

/**
 * Create a card element for an eval suite
 */
function createSuiteCard(suite: StoredEvalSuite): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card card-clickable';
  card.dataset.id = suite.id;

  // Header
  const header = document.createElement('div');
  header.className = 'card-header';

  const info = document.createElement('div');
  info.className = 'card-info';

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = suite.name;
  info.appendChild(title);

  if (suite.description) {
    const subtitle = document.createElement('div');
    subtitle.className = 'card-subtitle';
    subtitle.textContent = suite.description;
    info.appendChild(subtitle);
  }

  header.appendChild(info);
  card.appendChild(header);

  // Details
  const body = document.createElement('div');
  body.className = 'card-body';

  const scenarioDetail = document.createElement('div');
  scenarioDetail.className = 'card-detail';
  scenarioDetail.innerHTML = `<span class="detail-label">Scenarios:</span> <span class="detail-value">${suite.scenarios.length}</span>`;
  body.appendChild(scenarioDetail);

  if (suite.baseUrl) {
    const urlDetail = document.createElement('div');
    urlDetail.className = 'card-detail';
    urlDetail.innerHTML = `<span class="detail-label">Base URL:</span> <span class="detail-value monospace">${escapeHtml(suite.baseUrl)}</span>`;
    body.appendChild(urlDetail);
  }

  if (suite.fileName) {
    const fileDetail = document.createElement('div');
    fileDetail.className = 'card-detail';
    fileDetail.innerHTML = `<span class="detail-label">File:</span> <span class="detail-value monospace">${escapeHtml(suite.fileName)}</span>`;
    body.appendChild(fileDetail);
  }

  const dateDetail = document.createElement('div');
  dateDetail.className = 'card-detail';
  dateDetail.innerHTML = `<span class="detail-label">Imported:</span> <span class="detail-value">${new Date(suite.importedAt).toLocaleDateString()}</span>`;
  body.appendChild(dateDetail);

  // Tags from all scenarios
  const allTags = new Set<string>();
  for (const scenario of suite.scenarios) {
    if (scenario.tags) {
      for (const tag of scenario.tags) {
        allTags.add(tag);
      }
    }
  }
  if (allTags.size > 0) {
    const tagsDetail = document.createElement('div');
    tagsDetail.className = 'card-detail';
    tagsDetail.innerHTML = `<span class="detail-label">Tags:</span> <span class="detail-value">${[...allTags].map((t) => `<code>${escapeHtml(t)}</code>`).join(' ')}</span>`;
    body.appendChild(tagsDetail);
  }

  card.appendChild(body);

  // Delete button
  const actions = document.createElement('div');
  actions.className = 'card-header-actions';
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'button button-danger button-small';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (window.confirm(`Delete eval suite "${suite.name}"?`)) {
      await deleteEvalSuite(suite.id);
    }
  });
  actions.appendChild(deleteBtn);
  header.appendChild(actions);

  return card;
}

/**
 * Import an eval suite from a JSON file
 */
async function importEvalSuite(file: File): Promise<void> {
  try {
    const text = await readFile(file);
    const parsed = JSON.parse(text);

    // Validate structure
    if (!parsed.name || typeof parsed.name !== 'string') {
      throw new Error('Suite must have a "name" field');
    }
    if (!Array.isArray(parsed.scenarios) || parsed.scenarios.length === 0) {
      throw new Error('Suite must have at least one scenario');
    }

    for (const scenario of parsed.scenarios) {
      if (!scenario.id || !scenario.prompt) {
        throw new Error(`Each scenario must have "id" and "prompt" fields`);
      }
      if (!scenario.expectations || typeof scenario.expectations !== 'object') {
        throw new Error(`Scenario "${scenario.id}" must have "expectations" object`);
      }
    }

    const suite: EvalSuite = {
      name: parsed.name,
      description: parsed.description,
      baseUrl: parsed.baseUrl,
      scenarios: parsed.scenarios,
    };

    await configStorage.addEvalSuite(suite, file.name);
    showStatus(
      `Imported eval suite "${suite.name}" (${suite.scenarios.length} scenarios)`,
      'success'
    );
    await renderEvalSuites();
  } catch (error) {
    log.error('[EvalSuites] Import failed:', error);
    if (error instanceof SyntaxError) {
      showStatus('Invalid JSON file', 'error');
    } else if (error instanceof Error) {
      showStatus(`Import failed: ${error.message}`, 'error');
    } else {
      showStatus('Import failed: Unknown error', 'error');
    }
  }
}

/**
 * Delete an eval suite by ID
 */
async function deleteEvalSuite(id: string): Promise<void> {
  try {
    await configStorage.deleteEvalSuite(id);
    showStatus('Eval suite deleted', 'success');
    await renderEvalSuites();
  } catch (error) {
    log.error('[EvalSuites] Delete failed:', error);
    showStatus('Failed to delete eval suite', 'error');
  }
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showStatus(message: string, type: 'success' | 'error' | 'info'): void {
  const statusEl = document.getElementById('status-message');
  if (!statusEl) return;

  statusEl.textContent = message;
  statusEl.className = `status-message ${type}`;
  statusEl.style.display = 'block';

  const delay = type === 'error' ? 5000 : 3000;
  setTimeout(() => {
    statusEl.style.display = 'none';
  }, delay);
}
