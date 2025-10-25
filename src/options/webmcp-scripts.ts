/**
 * WebMCP Scripts management UI
 * Handles CRUD operations for user scripts in the Options page
 */

import log from '../lib/logger';
import { ConfigStorage, type UserScript, type UserScriptMetadata } from '../lib/storage/config';
import { parseUserScript, type ParsedScript } from '../lib/webmcp/script-parser';
import { getAllScriptsForInjection } from '../lib/webmcp/script-injector';
import { openModal, closeModal, setupBackdropHandler } from './modal-manager';
import { createCard, setupModalFooter, escapeHtml } from './card-component';
import { getAllBuiltinTools, type BuiltinToolInfo } from '../lib/webmcp/builtin-tools';
import { BUILTIN_SOURCES } from '../lib/webmcp/builtin-sources';

// Template script for new scripts
const SCRIPT_TEMPLATE = `'use webmcp-tool v1';

export const metadata = {
  name: "my_tool",
  namespace: "custom",
  version: "0.1.0",
  description: "Description of what this tool does",
  match: "<all_urls>",
  // Optional: define input schema for the tool
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" }
    },
    required: ["query"],
    additionalProperties: false
  }
};

export async function execute(args) {
  // Your tool logic here
  // args will be validated against inputSchema if provided
  
  // Return structured content or simple values
  return \`Processed: \${args.query}\`;
  
  // Or return MCP-style content blocks:
  // return {
  //   content: [
  //     { type: 'text', text: 'Result text' },
  //     { type: 'json', json: { data: 'value' } }
  //   ]
  // };
}`;

// Module-level state
let configStorage: ConfigStorage;
let editingScriptId: string | null = null;
let scripts: UserScript[] = [];
let builtinTools: Array<BuiltinToolInfo & { enabled: boolean }> = [];

/**
 * Initialize the WebMCP Scripts UI
 * Should be called from the main options page initialization
 */
export async function initializeWebMCPScripts() {
  configStorage = ConfigStorage.getInstance();
  await loadScripts();
  setupEventListeners();
  renderScripts();
}

async function loadScripts() {
  try {
    // Get user scripts
    scripts = await getAllScriptsForInjection();

    // Get built-in tools with their enabled state
    const allBuiltins = getAllBuiltinTools();
    const builtinStates = await configStorage.getBuiltinScripts();

    builtinTools = allBuiltins.map((tool) => ({
      ...tool,
      enabled: builtinStates.find((s) => s.id === tool.id)?.enabled ?? true, // Default: enabled
    }));
  } catch (error) {
    log.error('Failed to load scripts:', error);
    showStatus('Failed to load scripts', 'error');
  }
}

function setupEventListeners() {
  // Create script button
  document.getElementById('create-script')?.addEventListener('click', () => openCreateModal());

  // Modal controls
  document
    .getElementById('script-modal-close')
    ?.addEventListener('click', () => closeModal('script-modal'));
  setupBackdropHandler('script-modal');

  // Script form
  document.getElementById('validate-script')?.addEventListener('click', () => validateScript());
  document.getElementById('insert-template')?.addEventListener('click', () => insertTemplate());
  document.getElementById('format-code')?.addEventListener('click', () => formatCode());

  // Code editor changes
  const codeEditor = document.getElementById('script-code') as HTMLTextAreaElement;
  codeEditor?.addEventListener('input', () => onCodeChange());

  // Tab switching
  document.querySelectorAll('.tab-button').forEach((button) => {
    button.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const tab = target.dataset.tab;
      if (tab) switchTab(tab);
    });
  });
}

async function renderScripts() {
  const scriptsList = document.getElementById('scripts-list');
  const noScripts = document.getElementById('no-scripts');

  if (!scriptsList || !noScripts) return;

  // Clear existing content
  scriptsList.innerHTML = '';

  // Always hide the standalone empty state (we'll render inline if needed)
  noScripts.classList.add('hidden');

  // Always show the list if we have any tools
  const hasAnyTools = scripts.length > 0 || builtinTools.length > 0;
  if (hasAnyTools) {
    scriptsList.classList.remove('hidden');
  } else {
    scriptsList.classList.add('hidden');
    noScripts.classList.remove('hidden');
    return;
  }

  // If no user scripts, show inline empty state message
  if (scripts.length === 0) {
    const emptyState = document.createElement('div');
    emptyState.className = 'no-scripts-inline';
    emptyState.innerHTML = `
      <div class="no-scripts-content">
        <h3>No scripts configured</h3>
        <p>Create custom WebMCP tools that interact with web pages. Scripts can extract data, manipulate DOM, or provide page-specific functionality to your AI assistant.</p>
      </div>
    `;
    scriptsList.appendChild(emptyState);
  } else {
    // Render user scripts
    for (const script of scripts) {
      const card = createScriptCard(script);
      scriptsList.appendChild(card);
    }
  }

  // Add separator with "Built-in tools" label
  if (builtinTools.length > 0) {
    const separator = document.createElement('div');
    separator.className = 'tools-separator';
    separator.innerHTML = '<span class="separator-label">Built-in tools</span>';
    scriptsList.appendChild(separator);

    // Render built-in tools
    for (const tool of builtinTools) {
      const card = createBuiltinToolCard(tool);
      scriptsList.appendChild(card);
    }
  }
}

function createScriptCard(script: UserScript): HTMLElement {
  // Parse the script to get metadata
  let parsed: ParsedScript | null = null;
  try {
    // All scripts here are user scripts (built-in tools are now always enabled via lifecycle)
    parsed = parseUserScript(script.code, true);
  } catch (error) {
    log.warn(`Failed to parse script ${script.id}:`, error);
  }

  const metadata = parsed?.metadata || ({} as UserScriptMetadata);
  const name = metadata.name || 'Unnamed Script';
  const namespace = metadata.namespace || '';
  const fullName = namespace ? `${namespace}_${name}` : name;
  const version = metadata.version || '0.0.0';
  const description = metadata.description || 'No description available';
  const matchValue = metadata.match;
  const match = Array.isArray(matchValue) ? matchValue : matchValue ? [matchValue] : [];

  // Create custom content for match patterns
  const customContent = document.createElement('div');
  const patternsLabel = document.createElement('div');
  patternsLabel.className = 'script-detail';
  patternsLabel.innerHTML = '<span class="detail-label">Match patterns:</span>';
  customContent.appendChild(patternsLabel);

  const matchesContainer = document.createElement('div');
  matchesContainer.className = 'script-matches';
  if (match.length === 0) {
    matchesContainer.innerHTML = '<span class="match-pattern">No patterns defined</span>';
  } else {
    match.forEach((pattern: string) => {
      const patternEl = document.createElement('span');
      patternEl.className = 'match-pattern';
      patternEl.textContent = pattern;
      matchesContainer.appendChild(patternEl);
    });
  }
  customContent.appendChild(matchesContainer);

  return createCard({
    id: script.id,
    title: fullName,
    subtitle: `v${version} • ${description}`,
    customContent,
    toggle: {
      enabled: script.enabled,
      label: '',
      onToggle: () => toggleScript(script.id),
    },
    onEdit: () => openEditModal(script.id, false),
  });
}

function createBuiltinToolCard(tool: BuiltinToolInfo & { enabled: boolean }): HTMLElement {
  const fullName = tool.id; // e.g., 'agentboard_fetch_url'
  const description = tool.description || 'No description available';
  const match = tool.match || [];

  // Create custom content for match patterns
  const customContent = document.createElement('div');

  if (match.length > 0) {
    const patternsLabel = document.createElement('div');
    patternsLabel.className = 'script-detail';
    patternsLabel.innerHTML = '<span class="detail-label">Match patterns:</span>';
    customContent.appendChild(patternsLabel);

    const matchesContainer = document.createElement('div');
    matchesContainer.className = 'script-matches';
    match.forEach((pattern: string) => {
      const patternEl = document.createElement('span');
      patternEl.className = 'match-pattern';
      patternEl.textContent = pattern;
      matchesContainer.appendChild(patternEl);
    });
    customContent.appendChild(matchesContainer);
  }

  return createCard({
    id: tool.id,
    title: fullName,
    subtitle: `v${tool.version} • ${description}`,
    customContent,
    toggle: {
      enabled: tool.enabled,
      label: '',
      onToggle: () => toggleBuiltinTool(tool.id),
    },
    onEdit: () => openEditModal(tool.id, true),
  });
}

function openCreateModal() {
  editingScriptId = null;
  const modalTitle = document.getElementById('script-modal-title');

  if (modalTitle) {
    modalTitle.textContent = 'Create WebMCP Script';
  }
  clearForm();
  insertTemplate();

  // Re-enable text area for editing
  const scriptCode = document.getElementById('script-code') as HTMLTextAreaElement;
  if (scriptCode) {
    scriptCode.disabled = false;
  }

  // Hide builtin banner
  const banner = document.getElementById('builtin-banner');
  if (banner) banner.classList.add('hidden');

  // Setup modal footer (no delete for new scripts)
  setupModalFooter({
    modalId: 'script-modal',
    onSave: saveScript,
  });

  openModal('script-modal', () => {
    editingScriptId = null;
  });
}

async function openEditModal(scriptId: string, isBuiltin: boolean) {
  editingScriptId = scriptId;
  const modalTitle = document.getElementById('script-modal-title');
  const scriptCode = document.getElementById('script-code') as HTMLTextAreaElement;
  const banner = document.getElementById('builtin-banner');

  if (isBuiltin) {
    // Built-in tool: read-only mode
    if (modalTitle) {
      modalTitle.textContent = 'View Built-in Tool';
    }

    // Show banner
    if (banner) {
      banner.classList.remove('hidden');
    }

    // Load source code from bundle (read-only)
    const sourceCode = BUILTIN_SOURCES[scriptId] || '// Source code not available';
    if (scriptCode) {
      scriptCode.value = sourceCode;
      scriptCode.disabled = true; // Read-only
    }

    // Update metadata preview from built-in tool info
    const tool = builtinTools.find((t) => t.id === scriptId);
    if (tool) {
      updateBuiltinMetadataPreview(tool);
    }

    // Setup modal footer: no save/delete for built-ins
    // Pass empty functions that do nothing instead of undefined
    setupModalFooter({
      modalId: 'script-modal',
      onSave: () => {}, // No-op
      onDelete: undefined, // No delete button
    });
  } else {
    // User script: normal edit mode
    if (modalTitle) {
      modalTitle.textContent = 'Edit WebMCP Script';
    }

    // Hide banner
    if (banner) {
      banner.classList.add('hidden');
    }

    const script = scripts.find((s) => s.id === scriptId);
    if (script) {
      populateForm(script);
    }

    // Enable text area for editing
    if (scriptCode) {
      scriptCode.disabled = false;
    }

    // Get script name for delete confirmation
    let scriptName = script?.id || 'script';
    try {
      if (script) {
        const parsed = parseUserScript(script.code, true);
        const metadata = parsed?.metadata || ({} as UserScriptMetadata);
        const name = metadata.name || 'Unnamed Script';
        const namespace = metadata.namespace || '';
        scriptName = namespace ? `${namespace}_${name}` : name;
      }
    } catch {
      // Use ID as fallback
    }

    // Setup modal footer with delete button for editing
    setupModalFooter({
      modalId: 'script-modal',
      onSave: saveScript,
      onDelete: () => {
        if (window.confirm(`Delete script "${scriptName}"? This cannot be undone.`)) {
          deleteScript(scriptId);
        }
      },
    });
  }

  openModal('script-modal', () => {
    editingScriptId = null;
  });
}

function populateForm(script: UserScript) {
  const codeEditor = document.getElementById('script-code') as HTMLTextAreaElement;

  if (codeEditor) codeEditor.value = script.code;

  // Update preview
  onCodeChange();
}

function clearForm() {
  const codeEditor = document.getElementById('script-code') as HTMLTextAreaElement;

  if (codeEditor) codeEditor.value = '';

  // Clear preview
  updateMetadataPreview(null);
  updateValidationResults([]);
}

// closeModal is now imported from modal-manager

function insertTemplate() {
  const codeEditor = document.getElementById('script-code') as HTMLTextAreaElement;
  if (codeEditor) {
    codeEditor.value = SCRIPT_TEMPLATE;
    onCodeChange();
  }
}

function formatCode() {
  // Basic formatting: trim lines and ensure consistent indentation
  const codeEditor = document.getElementById('script-code') as HTMLTextAreaElement;
  if (!codeEditor) return;

  const lines = codeEditor.value.split('\n');
  const formattedLines = lines.map((line) => line.trimEnd());
  codeEditor.value = formattedLines.join('\n');

  showStatus('Code formatted', 'success');
}

async function saveScript() {
  const codeEditor = document.getElementById('script-code') as HTMLTextAreaElement;

  if (!codeEditor) return;

  const code = codeEditor.value.trim();
  if (!code) {
    showStatus('Script code is required', 'error');
    return;
  }

  // Validate before saving
  try {
    parseUserScript(code);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    showStatus(`Invalid script: ${errorMsg}`, 'error');
    return;
  }

  try {
    if (editingScriptId) {
      await configStorage.updateUserScript(editingScriptId, {
        code,
        enabled: true, // Always enabled on save; use card toggle to disable
      });
      showStatus('Script updated successfully!', 'success');
    } else {
      await configStorage.addUserScript(code, true); // Always enabled on save
      showStatus('Script created successfully!', 'success');
    }

    closeModal('script-modal');
    await loadScripts();
    await renderScripts();

    // Trigger hot reload of scripts in all tabs
    try {
      await chrome.runtime.sendMessage({ type: 'WEBMCP_SCRIPTS_UPDATED' });
      log.warn('[WebMCP Scripts] Triggered hot reload');
    } catch (error) {
      log.error('[WebMCP Scripts] Failed to trigger hot reload:', error);
    }
  } catch (error) {
    log.error('Failed to save script:', error);
    showStatus('Failed to save script', 'error');
  }
}

function validateScript() {
  const codeEditor = document.getElementById('script-code') as HTMLTextAreaElement;
  if (!codeEditor) return;

  const code = codeEditor.value.trim();
  const validationResults: Array<{ type: 'error' | 'warning' | 'success'; message: string }> = [];

  if (!code) {
    validationResults.push({ type: 'error', message: 'Script code is empty' });
  } else {
    try {
      const parsed = parseUserScript(code);
      validationResults.push({ type: 'success', message: 'Script is valid and ready to use!' });

      // Check for warnings
      if (!parsed.metadata.description) {
        validationResults.push({
          type: 'warning',
          message: 'Consider adding a description for better documentation',
        });
      }

      const match = Array.isArray(parsed.metadata.match)
        ? parsed.metadata.match
        : [parsed.metadata.match];
      if (match.includes('<all_urls>')) {
        validationResults.push({
          type: 'warning',
          message:
            'Script will run on all URLs. Consider limiting to specific patterns for better performance.',
        });
      }
    } catch (error) {
      validationResults.push({
        type: 'error',
        message: error instanceof Error ? error.message : 'Invalid script format',
      });
    }
  }

  // Switch to validation tab and show results
  switchTab('validation');
  updateValidationResults(validationResults);
}

function onCodeChange() {
  const codeEditor = document.getElementById('script-code') as HTMLTextAreaElement;
  if (!codeEditor) return;

  const code = codeEditor.value.trim();

  if (!code) {
    updateMetadataPreview(null);
    return;
  }

  try {
    const parsed = parseUserScript(code);
    updateMetadataPreview(parsed);
  } catch (error) {
    // Pass the error to display in the metadata tab
    updateMetadataPreview(null, error as Error);
  }
}

function updateMetadataPreview(parsed: ParsedScript | null, error?: Error) {
  const preview = document.getElementById('metadata-preview');
  if (!preview) return;

  // Update metadata tab button to show error indicator
  const metadataTabButton = document.querySelector('.tab-button[data-tab="metadata"]');

  // If there's a parsing error, show it prominently
  if (error) {
    // Add error indicator to tab button
    if (metadataTabButton) {
      metadataTabButton.classList.add('has-error');
      // Update button text to include error indicator
      if (!metadataTabButton.innerHTML.includes('⚠️')) {
        metadataTabButton.innerHTML = '⚠️ Metadata';
      }
    }

    preview.innerHTML = `
      <div class="metadata-error">
        <div class="error-icon">⚠️</div>
        <div class="error-title">Metadata Parsing Error</div>
        <div class="error-message">${escapeHtml(error.message)}</div>
        ${
          error.message.includes('snake_case')
            ? '<div class="error-hint">Example: use "my_tool" instead of "myTool" or "my-tool"</div>'
            : ''
        }
      </div>
    `;
    return;
  }

  // Clear error indicator from tab button
  if (metadataTabButton) {
    metadataTabButton.classList.remove('has-error');
    metadataTabButton.innerHTML = 'Metadata';
  }

  if (!parsed || !parsed.metadata) {
    preview.innerHTML = '<div class="metadata-empty">Write a script to see metadata</div>';
    return;
  }

  const metadata = parsed.metadata;
  const match = Array.isArray(metadata.match)
    ? metadata.match
    : metadata.match
      ? [metadata.match]
      : [];
  const exclude = Array.isArray(metadata.exclude)
    ? metadata.exclude
    : metadata.exclude
      ? [metadata.exclude]
      : [];

  preview.innerHTML = `
    ${
      metadata.name
        ? `
    <div class="metadata-field">
      <div class="metadata-label">Name</div>
      <div class="metadata-value monospace">${escapeHtml(metadata.name)}</div>
    </div>`
        : ''
    }
    
    ${
      metadata.namespace
        ? `
    <div class="metadata-field">
      <div class="metadata-label">Namespace</div>
      <div class="metadata-value monospace">${escapeHtml(metadata.namespace)}</div>
    </div>`
        : ''
    }
    
    ${
      metadata.version
        ? `
    <div class="metadata-field">
      <div class="metadata-label">Version</div>
      <div class="metadata-value monospace">${escapeHtml(metadata.version)}</div>
    </div>`
        : ''
    }
    
    ${
      metadata.description
        ? `
    <div class="metadata-field">
      <div class="metadata-label">Description</div>
      <div class="metadata-value">${escapeHtml(metadata.description)}</div>
    </div>`
        : ''
    }
    
    ${
      match.length > 0
        ? `
    <div class="metadata-field">
      <div class="metadata-label">URL Match Patterns</div>
      <ul class="metadata-list">
        ${match.map((pattern) => `<li>${escapeHtml(pattern)}</li>`).join('')}
      </ul>
    </div>`
        : ''
    }
    
    ${
      exclude.length > 0
        ? `
    <div class="metadata-field">
      <div class="metadata-label">Exclude Patterns</div>
      <ul class="metadata-list">
        ${exclude.map((pattern) => `<li>${escapeHtml(pattern)}</li>`).join('')}
      </ul>
    </div>`
        : ''
    }
    
    ${
      metadata.inputSchema
        ? `
    <div class="metadata-field">
      <div class="metadata-label">Input Schema</div>
      <div class="metadata-value monospace">${escapeHtml(JSON.stringify(metadata.inputSchema, null, 2))}</div>
    </div>`
        : ''
    }
  `;
}

function updateValidationResults(
  results: Array<{ type: 'error' | 'warning' | 'success'; message: string }>
) {
  const container = document.getElementById('validation-results');
  if (!container) return;

  if (results.length === 0) {
    container.innerHTML = '<div class="validation-empty">No validation issues</div>';
    return;
  }

  container.innerHTML = results
    .map(
      (result) => `
    <div class="validation-item ${result.type}">
      <div class="validation-icon">
        ${result.type === 'error' ? '❌' : result.type === 'warning' ? '⚠️' : '✅'}
      </div>
      <div class="validation-message">${escapeHtml(result.message)}</div>
    </div>
  `
    )
    .join('');
}

function switchTab(tab: string) {
  // Update tab buttons
  document.querySelectorAll('.tab-button').forEach((button) => {
    const btn = button as HTMLElement;
    if (btn.dataset.tab === tab) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Update tab content
  document.querySelectorAll('.tab-content').forEach((content) => {
    const el = content as HTMLElement;
    if (el.id === `${tab}-tab`) {
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  });
}

async function toggleScript(scriptId: string) {
  try {
    const script = scripts.find((s) => s.id === scriptId);
    if (!script) return;

    const newEnabled = !script.enabled;

    // Get current stored scripts
    const storedScripts = await configStorage.getUserScripts();
    const existingIndex = storedScripts.findIndex((s) => s.id === scriptId);

    if (existingIndex >= 0) {
      // Update existing entry
      storedScripts[existingIndex] = {
        id: scriptId,
        code: script.code,
        enabled: newEnabled,
      };
    } else {
      // Add new entry
      storedScripts.push({
        id: scriptId,
        code: script.code,
        enabled: newEnabled,
      });
    }

    // Save the updated scripts array
    await configStorage.set({ userScripts: storedScripts });

    await loadScripts();
    await renderScripts();

    showStatus(newEnabled ? 'Script enabled' : 'Script disabled', 'success');

    // Trigger hot reload
    try {
      await chrome.runtime.sendMessage({ type: 'WEBMCP_SCRIPTS_UPDATED' });
      log.warn('[WebMCP Scripts] Triggered hot reload after toggle');
    } catch (error) {
      log.error('[WebMCP Scripts] Failed to trigger hot reload:', error);
    }
  } catch (error) {
    log.error('Failed to toggle script:', error);
    showStatus('Failed to update script', 'error');
  }
}

async function deleteScript(scriptId: string) {
  try {
    await configStorage.deleteUserScript(scriptId);
    showStatus('Script deleted successfully', 'success');

    closeModal('script-modal');
    await loadScripts();
    await renderScripts();

    // Trigger hot reload
    try {
      await chrome.runtime.sendMessage({ type: 'WEBMCP_SCRIPTS_UPDATED' });
      log.warn('[WebMCP Scripts] Triggered hot reload after delete');
    } catch (error) {
      log.error('[WebMCP Scripts] Failed to trigger hot reload:', error);
    }
  } catch (error) {
    log.error('Failed to delete script:', error);
    showStatus('Failed to delete script', 'error');
  }
}

function showStatus(message: string, type: 'success' | 'error' | 'info' | 'warning') {
  // Use the existing status element from the main options page
  const statusEl = document.getElementById('status-message');
  if (!statusEl) return;

  statusEl.textContent = message;
  statusEl.className = `status-message ${type}`;
  statusEl.style.display = 'block';

  // Auto-hide after a delay
  setTimeout(
    () => {
      statusEl.style.display = 'none';
    },
    type === 'error' ? 5000 : 3000
  );
}

/**
 * Update metadata preview for built-in tools
 * Shows simplified metadata (no complex parsing needed)
 */
function updateBuiltinMetadataPreview(tool: BuiltinToolInfo) {
  const preview = document.getElementById('metadata-preview');
  if (!preview) return;

  const match = tool.match || [];

  preview.innerHTML = `
    <div class="metadata-field">
      <div class="metadata-label">ID</div>
      <div class="metadata-value monospace">${escapeHtml(tool.id)}</div>
    </div>
    
    <div class="metadata-field">
      <div class="metadata-label">Name</div>
      <div class="metadata-value monospace">${escapeHtml(tool.name)}</div>
    </div>
    
    <div class="metadata-field">
      <div class="metadata-label">Namespace</div>
      <div class="metadata-value monospace">${escapeHtml(tool.namespace)}</div>
    </div>
    
    <div class="metadata-field">
      <div class="metadata-label">Type</div>
      <div class="metadata-value">${escapeHtml(tool.type.toUpperCase())}</div>
    </div>
    
    <div class="metadata-field">
      <div class="metadata-label">Version</div>
      <div class="metadata-value monospace">${escapeHtml(tool.version)}</div>
    </div>
    
    <div class="metadata-field">
      <div class="metadata-label">Description</div>
      <div class="metadata-value">${escapeHtml(tool.description)}</div>
    </div>
    
    ${
      match.length > 0
        ? `
    <div class="metadata-field">
      <div class="metadata-label">URL Match Patterns</div>
      <ul class="metadata-list">
        ${match.map((pattern) => `<li>${escapeHtml(pattern)}</li>`).join('')}
      </ul>
    </div>`
        : ''
    }
    
    ${
      tool.inputSchema
        ? `
    <div class="metadata-field">
      <div class="metadata-label">Input Schema</div>
      <div class="metadata-value monospace">${escapeHtml(JSON.stringify(tool.inputSchema, null, 2))}</div>
    </div>`
        : ''
    }
  `;
}

/**
 * Toggle a built-in tool on/off
 */
async function toggleBuiltinTool(toolId: string) {
  try {
    const tool = builtinTools.find((t) => t.id === toolId);
    if (!tool) return;

    const newEnabled = !tool.enabled;

    // Update storage
    await configStorage.toggleBuiltinScript(toolId, newEnabled);

    // Reload and re-render
    await loadScripts();
    await renderScripts();

    showStatus(newEnabled ? 'Built-in tool enabled' : 'Built-in tool disabled', 'success');

    // Trigger reload of tabs (they'll check enabled state on next navigation)
    log.debug('[WebMCP Scripts] Built-in tool toggled:', toolId, newEnabled);
  } catch (error) {
    log.error('Failed to toggle built-in tool:', error);
    showStatus('Failed to update tool', 'error');
  }
}
