/**
 * Options page logic
 * Handles agent configuration and management
 */

import log from '../lib/logger';
import './styles.css';
import {
  ConfigStorage,
  BASE_SYSTEM_PROMPT,
  type AgentConfig,
  type MCPConfig,
  type ReasoningConfig,
} from '../lib/storage/config';
import { getRemoteMCPManager } from '../lib/mcp/manager';
import type { MCPServerStatus } from '../lib/mcp/manager';
import { initializeWebMCPScripts } from './webmcp-scripts';
import { initializeCommands } from './commands';
import { openModal, closeModal, setupBackdropHandler } from './modal-manager';
import { initializeBackupRestore } from './backup-restore';
import {
  createCard,
  setupModalFooter,
  showModalStatus,
  type Badge,
  type Detail,
} from './card-component';
import { inferProviderFromModel, getProviderDisplay } from '../lib/ai/provider-utils';

// Get config storage instance
const configStorage = ConfigStorage.getInstance();
let editingAgentId: string | null = null;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  await renderAgents();
  await loadLogLevel();
  await loadMCPConfig();
  await initializeWebMCPScripts();
  await initializeCommands();
  await initializeBackupRestore();
});

async function renderAgents() {
  const agentsList = document.getElementById('agents-list');
  const noAgents = document.getElementById('no-agents');

  if (!agentsList || !noAgents) {
    log.error('Required DOM elements not found for rendering agents');
    return;
  }

  const agents = await configStorage.getAgents();

  // Clear existing content
  agentsList.innerHTML = '';

  if (agents.length === 0) {
    agentsList.classList.add('hidden');
    noAgents.classList.remove('hidden');
    return;
  }

  agentsList.classList.remove('hidden');
  noAgents.classList.add('hidden');

  // Render agent cards
  agents.forEach((agent) => {
    const card = createAgentCard(agent);
    agentsList.appendChild(card);
  });
}

function createAgentCard(agent: AgentConfig): HTMLElement {
  // Infer provider from model if not explicitly set
  const inferredProvider = inferProviderFromModel(agent.model);
  const providerDisplay = getProviderDisplay(inferredProvider);

  // Show provider with proxy indicator if using custom endpoint
  const hasProxy = !!agent.endpoint;
  const providerText = hasProxy
    ? `🌐 ${providerDisplay.name}`.toUpperCase()
    : providerDisplay.name.toUpperCase();

  const badges: Badge[] = [
    {
      text: providerText,
      className: `provider-badge provider-${inferredProvider}`,
      title: hasProxy ? `Using ${agent.endpoint}` : undefined,
    },
  ];

  if (agent.isDefault) {
    badges.push({
      text: 'DEFAULT',
      className: 'default-badge',
    });
  }

  const details: Detail[] = [
    { label: 'Model:', value: agent.model, valueClassName: 'monospace' },
    { label: 'Temperature:', value: agent.temperature.toString() },
    { label: 'Max Tokens:', value: agent.maxTokens.toString() },
  ];

  // Add endpoint info if present
  if (agent.endpoint) {
    details.push({
      label: 'Endpoint:',
      value: agent.endpoint,
      valueClassName: 'endpoint-url',
    });
  }

  return createCard({
    id: agent.id,
    title: agent.name,
    subtitle: agent.description,
    badges,
    details,
    onEdit: () => openEditModal(agent.id),
  });
}

function setupEventListeners() {
  // Create agent button
  document.getElementById('create-agent')?.addEventListener('click', () => openCreateModal());

  // Modal controls
  document
    .getElementById('modal-close')
    ?.addEventListener('click', () => closeModal('agent-modal'));
  setupBackdropHandler('agent-modal');

  // Log level selection
  document.getElementById('log-level')?.addEventListener('change', updateLogLevel);

  // Update API key required state when endpoint changes
  document.getElementById('agent-endpoint')?.addEventListener('input', () => {
    updateApiKeyRequirement();
    updateOpenAICompatibleVisibility();
  });

  // Track when user explicitly sets the OpenAI-compatible checkbox
  document.getElementById('agent-openai-compatible')?.addEventListener('change', (e) => {
    const checkbox = e.target as HTMLInputElement;
    // Mark that the user has explicitly set this value
    checkbox.setAttribute('data-user-set', 'true');
  });

  // Update inferred provider when model changes
  document.getElementById('agent-model')?.addEventListener('input', () => {
    updateInferredProvider();
    updateReasoningVisibility();
    validateModelReasoning();
  });

  // Reasoning configuration
  document.getElementById('reasoning-enabled')?.addEventListener('change', toggleReasoningSettings);

  // MCP configuration
  document.getElementById('test-mcp-config')?.addEventListener('click', testMCPConfig);

  // Auto-save MCP config on change with validation
  const mcpConfigTextarea = document.getElementById('mcp-config') as HTMLTextAreaElement;
  if (mcpConfigTextarea) {
    let saveTimeout: number | undefined;
    mcpConfigTextarea.addEventListener('input', () => {
      // Debounce auto-save
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = window.setTimeout(async () => {
        await saveMCPConfigWithValidation();
      }, 1000);
    });
  }
}

function openCreateModal() {
  editingAgentId = null;
  const modalTitle = document.getElementById('modal-title');
  const form = document.getElementById('agent-form') as HTMLFormElement;

  if (modalTitle) {
    modalTitle.textContent = 'New Agent';
  }

  // Reset form to clear all validation states
  form?.reset();

  // Set default values without triggering validation
  setDefaultFormValues();

  // Setup modal footer (no delete for new agents)
  setupModalFooter({
    modalId: 'agent-modal',
    onSave: saveAgent,
    onTest: testCurrentAgent,
  });

  // Hide inferred provider for new agent (no model entered yet)
  const inferredProviderDiv = document.getElementById('inferred-provider');
  if (inferredProviderDiv) {
    inferredProviderDiv.classList.add('hidden');
  }

  // Clear OpenAI-compatible checkbox state for new agent
  const compatibleCheckbox = document.getElementById('agent-openai-compatible') as HTMLInputElement;
  if (compatibleCheckbox) {
    compatibleCheckbox.checked = false;
    compatibleCheckbox.removeAttribute('data-user-set');
  }

  openModal('agent-modal', () => {
    editingAgentId = null;
  });
}

async function openEditModal(agentId: string) {
  editingAgentId = agentId;
  const modalTitle = document.getElementById('modal-title');

  if (modalTitle) {
    modalTitle.textContent = 'Edit Agent';
  }
  await populateForm(agentId);

  // Get agent for delete confirmation
  const agent = await configStorage.getAgent(agentId);

  // Setup modal footer with delete button for editing
  setupModalFooter({
    modalId: 'agent-modal',
    onSave: saveAgent,
    onTest: testCurrentAgent,
    onDelete: agent
      ? () => {
          if (window.confirm(`Delete agent "${agent.name}"? This cannot be undone.`)) {
            deleteAgent(agentId);
          }
        }
      : undefined,
  });

  openModal('agent-modal', () => {
    editingAgentId = null;
  });
}

async function populateForm(agentId: string) {
  const agent = await configStorage.getAgent(agentId);
  if (!agent) return;

  const apiKeyInput = document.getElementById('agent-api-key') as HTMLInputElement;
  const endpointValue = agent.endpoint || '';

  (document.getElementById('agent-name') as HTMLInputElement).value = agent.name;
  (document.getElementById('agent-description') as HTMLInputElement).value =
    agent.description || '';
  apiKeyInput.value = agent.apiKey || '';
  (document.getElementById('agent-model') as HTMLInputElement).value = agent.model;
  (document.getElementById('agent-endpoint') as HTMLInputElement).value = endpointValue;

  // Set OpenAI-compatible checkbox - only check if explicitly set by user
  const compatibleCheckbox = document.getElementById('agent-openai-compatible') as HTMLInputElement;
  if (compatibleCheckbox) {
    if (endpointValue && agent.openaiCompatible !== undefined) {
      // User has explicitly set this value
      compatibleCheckbox.checked = agent.openaiCompatible;
      compatibleCheckbox.setAttribute('data-user-set', 'true');
    } else {
      // No explicit value set - leave unchecked and clear the attribute
      compatibleCheckbox.checked = false;
      compatibleCheckbox.removeAttribute('data-user-set');
    }
  }

  (document.getElementById('agent-system-prompt') as HTMLTextAreaElement).value =
    agent.systemPrompt;
  (document.getElementById('agent-temperature') as HTMLInputElement).value =
    agent.temperature.toString();
  (document.getElementById('agent-max-tokens') as HTMLInputElement).value =
    agent.maxTokens.toString();
  (document.getElementById('agent-is-default') as HTMLInputElement).checked =
    agent.isDefault || false;

  // Populate reasoning configuration
  populateReasoningConfig(agent);

  // Update UI state
  updateInferredProvider();
  updateApiKeyRequirement();
  updateOpenAICompatibleVisibility();
  updateReasoningVisibility();
}

function setDefaultFormValues() {
  // Set default system prompt
  const systemPromptEl = document.getElementById('agent-system-prompt') as HTMLTextAreaElement;
  if (systemPromptEl) {
    systemPromptEl.value = BASE_SYSTEM_PROMPT;
  }

  // Set default temperature
  const temperatureEl = document.getElementById('agent-temperature') as HTMLInputElement;
  if (temperatureEl) {
    temperatureEl.value = '0.7';
  }

  // Set default max tokens
  const maxTokensEl = document.getElementById('agent-max-tokens') as HTMLInputElement;
  if (maxTokensEl) {
    maxTokensEl.value = '4000';
  }

  // Clear reasoning configuration
  clearReasoningConfig();

  // Update API key requirement based on empty endpoint (without triggering validation)
  updateApiKeyRequirement();
}

// closeModal is now imported from modal-manager

async function saveAgent() {
  const form = document.getElementById('agent-form') as HTMLFormElement;

  if (!form.reportValidity()) {
    return;
  }

  const endpointValue = (
    document.getElementById('agent-endpoint') as HTMLInputElement
  ).value.trim();
  const apiKeyValue = (document.getElementById('agent-api-key') as HTMLInputElement).value.trim();

  try {
    // Collect reasoning configuration
    const reasoningConfig = collectReasoningConfig();

    const model = (document.getElementById('agent-model') as HTMLInputElement).value.trim();
    const provider = inferProviderFromModel(model);

    const agentData: Omit<AgentConfig, 'id'> = {
      name: (document.getElementById('agent-name') as HTMLInputElement).value.trim(),
      description:
        (document.getElementById('agent-description') as HTMLInputElement).value.trim() ||
        undefined,
      provider,
      apiKey: apiKeyValue || undefined, // Set to undefined if empty
      model,
      endpoint: endpointValue || undefined,
      openaiCompatible: (() => {
        if (!endpointValue) return undefined;
        const checkbox = document.getElementById('agent-openai-compatible') as HTMLInputElement;
        // Only save the value if the user explicitly set it
        // Otherwise, let the backend use smart detection
        return checkbox?.hasAttribute('data-user-set') ? checkbox.checked : undefined;
      })(),
      systemPrompt: (document.getElementById('agent-system-prompt') as HTMLTextAreaElement).value,
      temperature: parseFloat(
        (document.getElementById('agent-temperature') as HTMLInputElement).value
      ),
      maxTokens: parseInt(
        (document.getElementById('agent-max-tokens') as HTMLInputElement).value,
        10
      ),
      isDefault: (document.getElementById('agent-is-default') as HTMLInputElement).checked,
      reasoning: reasoningConfig,
    };

    if (editingAgentId) {
      await configStorage.updateAgent(editingAgentId, agentData);
      showStatus('Agent updated successfully!', 'success');
    } else {
      await configStorage.addAgent(agentData);
      showStatus('Agent created successfully!', 'success');
    }

    // Notify background script of config change
    const newConfig = await configStorage.get();
    await chrome.runtime.sendMessage({
      type: 'SAVE_CONFIG',
      config: newConfig,
    } as const);

    closeModal('agent-modal');
    await renderAgents();
  } catch (error) {
    log.error('Failed to save agent:', error);
    showStatus('Failed to save agent', 'error');
  }
}

async function testCurrentAgent() {
  const form = document.getElementById('agent-form') as HTMLFormElement;

  if (!form.reportValidity()) {
    return;
  }

  const endpointValue = (
    document.getElementById('agent-endpoint') as HTMLInputElement
  ).value.trim();
  const apiKeyValue = (document.getElementById('agent-api-key') as HTMLInputElement).value.trim();

  showModalStatus('agent-modal', 'Testing connection...', 'info');

  try {
    const model = (document.getElementById('agent-model') as HTMLInputElement).value.trim();
    const provider = inferProviderFromModel(model);

    // Test the connection directly without saving temp agent
    const result = await new Promise<{ success: boolean; message: string }>((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: 'TEST_NEW_CONNECTION',
          provider,
          apiKey: apiKeyValue || undefined, // Allow undefined for custom endpoints
          model,
          endpoint: endpointValue || undefined,
        } as const,
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response);
        }
      );
    });

    if (!result) {
      showModalStatus('agent-modal', 'No response from background script', 'error');
      return;
    }

    if (result.success) {
      showModalStatus('agent-modal', result.message, 'success');
    } else {
      showModalStatus('agent-modal', result.message || 'Connection test failed', 'error');
    }
  } catch (error) {
    log.error('Connection test error:', error);
    showModalStatus('agent-modal', 'Failed to test connection', 'error');
  }
}

async function deleteAgent(agentId: string) {
  try {
    await configStorage.deleteAgent(agentId);
    showStatus('Agent deleted successfully', 'success');

    // Notify background script of config change
    const newConfig = await configStorage.get();
    await chrome.runtime.sendMessage({
      type: 'SAVE_CONFIG',
      config: newConfig,
    } as const);

    closeModal('agent-modal');
    await renderAgents();
  } catch (error) {
    log.error('Failed to delete agent:', error);
    showStatus('Failed to delete agent', 'error');
  }
}

// Log level management
async function loadLogLevel() {
  try {
    const config = await configStorage.get();
    const logLevelSelect = document.getElementById('log-level') as HTMLSelectElement;
    if (logLevelSelect && config.logLevel) {
      logLevelSelect.value = config.logLevel;
    }
  } catch (error) {
    log.error('Failed to load log level:', error);
  }
}

async function updateLogLevel() {
  const select = document.getElementById('log-level') as HTMLSelectElement;
  const selectedLogLevel = select.value;

  try {
    await configStorage.set({ logLevel: selectedLogLevel });
    showStatus(`Log level set to ${selectedLogLevel.toUpperCase()}`, 'success');
  } catch (error) {
    log.error('Failed to update log level:', error);
    showStatus('Failed to update log level', 'error');
  }
}

function updateApiKeyRequirement() {
  const endpointInput = document.getElementById('agent-endpoint') as HTMLInputElement;
  const apiKeyInput = document.getElementById('agent-api-key') as HTMLInputElement;
  const hintEl = document.querySelector('.api-key-hint') as HTMLElement;
  const endpoint = endpointInput?.value?.trim();

  if (apiKeyInput) {
    // Toggle required attribute based on endpoint presence
    if (endpoint) {
      apiKeyInput.removeAttribute('required');
    } else {
      apiKeyInput.setAttribute('required', '');
    }
  }

  // Update hint text
  if (hintEl) {
    if (endpoint) {
      hintEl.textContent = '✓ Optional with proxy URL';
      hintEl.className = 'api-key-hint valid';
    } else {
      hintEl.textContent = '';
      hintEl.className = 'api-key-hint';
    }
  }
}

function updateOpenAICompatibleVisibility() {
  const endpointInput = document.getElementById('agent-endpoint') as HTMLInputElement;
  const compatibleGroup = document.getElementById('openai-compatible-group') as HTMLDivElement;
  const compatibleCheckbox = document.getElementById('agent-openai-compatible') as HTMLInputElement;
  const endpoint = endpointInput?.value?.trim();

  if (compatibleGroup) {
    if (endpoint) {
      // Show checkbox when endpoint is set
      compatibleGroup.style.display = 'block';

      // Don't auto-check based on smart detection - let user decide
      // The backend will use smart detection if the value is undefined
    } else {
      // Hide when no endpoint
      compatibleGroup.style.display = 'none';
      // Clear the user-set attribute when endpoint is removed
      if (compatibleCheckbox) {
        compatibleCheckbox.removeAttribute('data-user-set');
      }
    }
  }
}

function updateInferredProvider() {
  const modelInput = document.getElementById('agent-model') as HTMLInputElement;
  const inferredProviderDiv = document.getElementById('inferred-provider');
  const inferredProviderText = document.getElementById('inferred-provider-text');

  if (!modelInput || !inferredProviderDiv || !inferredProviderText) return;

  const model = modelInput.value.trim();
  if (!model) {
    inferredProviderDiv.classList.add('hidden');
    return;
  }

  const provider = inferProviderFromModel(model);
  const providerDisplay = getProviderDisplay(provider);

  inferredProviderText.textContent = providerDisplay.name;
  inferredProviderDiv.classList.remove('hidden');
}

function showStatus(message: string, type: 'success' | 'error' | 'info') {
  const statusEl = document.getElementById('status-message');
  if (!statusEl) return;

  statusEl.textContent = message;
  statusEl.className = `status-message ${type}`;
  statusEl.style.display = 'block';

  // Auto-hide after 3 seconds for success/info, 5 seconds for errors
  setTimeout(
    () => {
      statusEl.style.display = 'none';
    },
    type === 'error' ? 5000 : 3000
  );
}

// MCP Configuration Functions
async function loadMCPConfig() {
  const mcpConfigTextarea = document.getElementById('mcp-config') as HTMLTextAreaElement;
  if (!mcpConfigTextarea) return;

  try {
    const config = await configStorage.get();
    if (config.mcpConfig) {
      mcpConfigTextarea.value = JSON.stringify(config.mcpConfig, null, 2);
    }
  } catch (error) {
    log.error('Failed to load MCP configuration:', error);
  }
}

async function testMCPConfig() {
  const mcpConfigTextarea = document.getElementById('mcp-config') as HTMLTextAreaElement;
  const statusDiv = document.getElementById('mcp-status');
  const statusContent = document.getElementById('mcp-status-content');

  if (!mcpConfigTextarea || !statusDiv || !statusContent) return;

  try {
    // Parse the JSON config
    const configText = mcpConfigTextarea.value.trim();
    if (!configText) {
      showStatus('Please enter an MCP configuration', 'error');
      return;
    }

    const mcpConfig: MCPConfig = JSON.parse(configText);

    // Validate the structure
    if (!mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== 'object') {
      showStatus('Invalid configuration: mcpServers must be an object', 'error');
      return;
    }

    if (Array.isArray(mcpConfig.mcpServers)) {
      showStatus('mcpServers should be an object with server names as keys, not an array', 'error');
      return;
    }

    // Validate each server configuration
    for (const [serverName, serverConfig] of Object.entries(mcpConfig.mcpServers)) {
      // Check transport type
      if (!serverConfig.transport) {
        showStatus(`Server "${serverName}": missing "transport" field`, 'error');
        return;
      }

      if (serverConfig.transport !== 'http') {
        showStatus(
          `Server "${serverName}": only "http" transport is supported (got "${serverConfig.transport}")`,
          'error'
        );
        return;
      }

      // Check URL is present and valid
      if (!serverConfig.url) {
        showStatus(`Server "${serverName}": missing "url" field`, 'error');
        return;
      }

      try {
        const url = new URL(serverConfig.url);
        if (!url.protocol.startsWith('http')) {
          showStatus(`Server "${serverName}": URL must use http or https protocol`, 'error');
          return;
        }
      } catch (urlError) {
        if (urlError instanceof TypeError) {
          showStatus(`Server "${serverName}": invalid URL format "${serverConfig.url}"`, 'error');
          return;
        }
        throw urlError;
      }
    }

    showStatus('Testing MCP connections...', 'info');

    // Test connections using the Remote MCP manager
    const remoteMCPManager = getRemoteMCPManager();
    const statuses = await remoteMCPManager.loadConfig(mcpConfig);

    // Display the results
    displayMCPStatus(statuses);
    statusDiv.classList.remove('hidden');

    // Show success/error message
    const connectedCount = statuses.filter((s) => s.status === 'connected').length;
    const totalCount = statuses.length;

    if (connectedCount === totalCount) {
      showStatus(`All ${totalCount} server(s) connected successfully!`, 'success');
    } else if (connectedCount > 0) {
      showStatus(`Connected to ${connectedCount} of ${totalCount} server(s)`, 'info');
    } else {
      showStatus('Failed to connect to any servers', 'error');
    }
  } catch (error) {
    log.error('Failed to test MCP configuration:', error);
    if (error instanceof SyntaxError) {
      showStatus('Invalid JSON format', 'error');
    } else {
      showStatus(
        `Test failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'error'
      );
    }
  }
}

/**
 * Validate and auto-save MCP configuration
 * Shows inline validation errors and saves automatically when valid
 */
async function saveMCPConfigWithValidation() {
  const mcpConfigTextarea = document.getElementById('mcp-config') as HTMLTextAreaElement;
  if (!mcpConfigTextarea) return;

  try {
    const configText = mcpConfigTextarea.value.trim();

    // Allow saving empty config
    if (!configText) {
      mcpConfigTextarea.setCustomValidity('');
      await configStorage.set({ mcpConfig: undefined });
      log.debug('MCP configuration cleared');
      return;
    }

    // Parse and validate the JSON
    const mcpConfig: MCPConfig = JSON.parse(configText);

    // Validate the structure
    if (!mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== 'object') {
      throw new Error('Configuration must include "mcpServers" object');
    }

    // Validate that it's not an array (common mistake)
    if (Array.isArray(mcpConfig.mcpServers)) {
      throw new Error('mcpServers should be an object with server names as keys, not an array');
    }

    // Validate each server configuration
    for (const [serverName, serverConfig] of Object.entries(mcpConfig.mcpServers)) {
      // Check transport type
      if (!serverConfig.transport) {
        throw new Error(`Server "${serverName}": missing "transport" field`);
      }

      if (serverConfig.transport !== 'http') {
        throw new Error(
          `Server "${serverName}": only "http" transport is supported (got "${serverConfig.transport}")`
        );
      }

      // Check URL is present and valid
      if (!serverConfig.url) {
        throw new Error(`Server "${serverName}": missing "url" field`);
      }

      try {
        const url = new URL(serverConfig.url);
        if (!url.protocol.startsWith('http')) {
          throw new Error('URL must use http or https protocol');
        }
      } catch (urlError) {
        if (urlError instanceof TypeError) {
          throw new Error(`Server "${serverName}": invalid URL format "${serverConfig.url}"`);
        }
        throw urlError;
      }
    }

    // Clear any validation error
    mcpConfigTextarea.setCustomValidity('');

    // Save the configuration
    await configStorage.set({ mcpConfig });
    log.debug('MCP configuration auto-saved');
  } catch (error) {
    log.debug('MCP configuration validation failed:', error);

    // Set custom validity message
    let errorMessage = 'Invalid configuration';
    if (error instanceof SyntaxError) {
      errorMessage = 'Invalid JSON format';
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }

    mcpConfigTextarea.setCustomValidity(errorMessage);
    mcpConfigTextarea.reportValidity();
  }
}

function displayMCPStatus(statuses: MCPServerStatus[]) {
  const statusContent = document.getElementById('mcp-status-content');
  if (!statusContent) return;

  statusContent.innerHTML = '';

  for (const status of statuses) {
    const serverDiv = document.createElement('div');
    serverDiv.className = `mcp-server-status ${status.status}`;

    const nameDiv = document.createElement('div');
    nameDiv.className = 'mcp-server-name';
    nameDiv.textContent = `${status.status === 'connected' ? '✅' : '❌'} ${status.name}`;
    serverDiv.appendChild(nameDiv);

    if (status.error) {
      const errorDiv = document.createElement('div');
      errorDiv.className = 'mcp-server-error';
      errorDiv.textContent = `Error: ${status.error}`;
      serverDiv.appendChild(errorDiv);
    }

    if (status.tools && status.tools.length > 0) {
      const toolsDiv = document.createElement('div');
      toolsDiv.className = 'mcp-server-tools';
      toolsDiv.innerHTML = `<div style="margin-bottom: 4px;">Tools (${status.tools.length}):</div>`;

      for (const tool of status.tools) {
        const toolDiv = document.createElement('div');
        toolDiv.className = 'mcp-tool-item';
        toolDiv.textContent = tool.name;

        if (tool.description) {
          const descDiv = document.createElement('div');
          descDiv.className = 'mcp-tool-description';
          descDiv.textContent = tool.description;
          toolDiv.appendChild(descDiv);
        }

        toolsDiv.appendChild(toolDiv);
      }

      serverDiv.appendChild(toolsDiv);
    }

    statusContent.appendChild(serverDiv);
  }
}

function toggleReasoningSettings() {
  const enabled = (document.getElementById('reasoning-enabled') as HTMLInputElement)?.checked;
  const settingsDiv = document.getElementById('reasoning-settings');

  if (settingsDiv) {
    if (enabled) {
      settingsDiv.classList.remove('hidden');
    } else {
      settingsDiv.classList.add('hidden');
    }
  }
}

function updateReasoningVisibility() {
  const modelInput = document.getElementById('agent-model') as HTMLInputElement;
  const model = modelInput?.value.trim() || '';

  // Hide all provider-specific sections
  document.getElementById('reasoning-openai')?.classList.add('hidden');
  document.getElementById('reasoning-anthropic')?.classList.add('hidden');
  document.getElementById('reasoning-google')?.classList.add('hidden');

  if (model) {
    const provider = inferProviderFromModel(model);
    document.getElementById(`reasoning-${provider}`)?.classList.remove('hidden');
  }
}

function validateModelReasoning() {
  const incompatibleWarning = document.getElementById('reasoning-incompatible');
  incompatibleWarning?.classList.add('hidden');

  // Always enable the reasoning checkbox
  const reasoningCheckbox = document.getElementById('reasoning-enabled') as HTMLInputElement;
  if (reasoningCheckbox) {
    reasoningCheckbox.disabled = false;
  }
}

function populateReasoningConfig(agent: AgentConfig) {
  const reasoning = agent.reasoning;

  // Set enabled state
  (document.getElementById('reasoning-enabled') as HTMLInputElement).checked =
    reasoning?.enabled || false;

  // Show/hide settings based on enabled state
  if (reasoning?.enabled) {
    document.getElementById('reasoning-settings')?.classList.remove('hidden');
  } else {
    document.getElementById('reasoning-settings')?.classList.add('hidden');
  }

  // Populate provider-specific settings
  if (reasoning?.openai) {
    (document.getElementById('reasoning-effort') as HTMLSelectElement).value =
      reasoning.openai.reasoningEffort || 'medium';
    (document.getElementById('reasoning-summary') as HTMLSelectElement).value =
      reasoning.openai.reasoningSummary || 'auto';
  }

  if (reasoning?.anthropic) {
    (document.getElementById('thinking-budget') as HTMLInputElement).value = (
      reasoning.anthropic.thinkingBudgetTokens || 12000
    ).toString();
  }

  if (reasoning?.google) {
    (document.getElementById('thinking-budget-google') as HTMLInputElement).value = (
      reasoning.google.thinkingBudget ?? 8192
    ).toString();
    (document.getElementById('include-thoughts') as HTMLInputElement).checked =
      reasoning.google.includeThoughts ?? true;
  }

  // UI settings
  (document.getElementById('reasoning-auto-expand') as HTMLInputElement).checked =
    reasoning?.autoExpand ?? true;
}

function clearReasoningConfig() {
  (document.getElementById('reasoning-enabled') as HTMLInputElement).checked = false;
  document.getElementById('reasoning-settings')?.classList.add('hidden');

  // Reset to defaults
  (document.getElementById('reasoning-effort') as HTMLSelectElement).value = 'medium';
  (document.getElementById('reasoning-summary') as HTMLSelectElement).value = 'auto';
  (document.getElementById('thinking-budget') as HTMLInputElement).value = '12000';
  (document.getElementById('thinking-budget-google') as HTMLInputElement).value = '8192';
  (document.getElementById('include-thoughts') as HTMLInputElement).checked = true;
  (document.getElementById('reasoning-auto-expand') as HTMLInputElement).checked = true;
}

function collectReasoningConfig(): ReasoningConfig | undefined {
  const enabled = (document.getElementById('reasoning-enabled') as HTMLInputElement)?.checked;

  if (!enabled) {
    return undefined;
  }

  const modelInput = document.getElementById('agent-model') as HTMLInputElement;
  const model = modelInput?.value.trim() || '';
  const provider = inferProviderFromModel(model);

  const config: ReasoningConfig = {
    enabled: true,
    autoExpand: (document.getElementById('reasoning-auto-expand') as HTMLInputElement)?.checked,
  };

  // Collect provider-specific settings
  switch (provider) {
    case 'openai':
      config.openai = {
        reasoningEffort: (document.getElementById('reasoning-effort') as HTMLSelectElement)
          ?.value as 'minimal' | 'low' | 'medium' | 'high',
        reasoningSummary: (document.getElementById('reasoning-summary') as HTMLSelectElement)
          ?.value as 'auto' | 'detailed' | undefined,
      };
      break;

    case 'anthropic':
      config.anthropic = {
        thinkingBudgetTokens: parseInt(
          (document.getElementById('thinking-budget') as HTMLInputElement)?.value || '12000'
        ),
      };
      break;

    case 'google':
      config.google = {
        thinkingBudget: parseInt(
          (document.getElementById('thinking-budget-google') as HTMLInputElement)?.value || '8192'
        ),
        includeThoughts: (document.getElementById('include-thoughts') as HTMLInputElement)?.checked,
      };
      break;
  }

  return config;
}

export {};
