/**
 * Options page logic
 * Handles agent configuration and management
 */

import log from '../lib/logger';
import './styles.css';
import {
  ConfigStorage,
  ConfigValidationError,
  configValidationMessage,
  type AgentConfig,
  type LogLevel,
  type MCPConfig,
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
  generateDuplicateName,
  type Badge,
  type Detail,
} from './card-component';
import { providerForApiProtocol } from '../lib/ai/protocol';
import { protocolBadgeLabel } from './agent-protocol';
import { AgentMemoryControls } from './agent-memory';
import {
  agentToEditorState,
  defaultAgentEditorState,
  initializeAgentEditor,
  readAgentDraft,
  renderAgentEditor,
  setAgentEditorBusy,
} from './agent-editor';
import type { ExtensionMessage } from '../types';

// Get config storage instance
const configStorage = ConfigStorage.getInstance();
let agentMemoryControls: AgentMemoryControls;
let editingAgentId: string | null = null;
let connectionTestGeneration = 0;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Recovery must remain operable even when the editor DOM or configuration is unavailable.
  await initializeBackupRestore();
  try {
    agentMemoryControls = new AgentMemoryControls(document);
    setupEventListeners();
    await renderAgents();
    await loadLogLevel();
    await loadMCPConfig();
    await initializeWebMCPScripts();
    await initializeCommands();
  } catch (error) {
    log.error(
      'Failed to initialize settings:',
      error instanceof ConfigValidationError ? error.code : 'CONFIGURATION_UNAVAILABLE'
    );
    showStatus(configValidationMessage(error), 'error', false);
  }
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
  const provider = providerForApiProtocol(agent.apiProtocol);
  const hasProxy = !!agent.endpoint;
  const protocolLabel = protocolBadgeLabel(agent.apiProtocol);

  const badges: Badge[] = [
    {
      text: hasProxy ? `🌐 ${protocolLabel}` : protocolLabel,
      className: `provider-badge provider-${provider}`,
      title: hasProxy ? 'Using a custom endpoint' : undefined,
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
  agentMemoryControls.initialize();

  // Create agent button
  document.getElementById('create-agent')?.addEventListener('click', () => openCreateModal());

  // Modal controls
  document
    .getElementById('modal-close')
    ?.addEventListener('click', () => closeModal('agent-modal'));
  setupBackdropHandler('agent-modal');

  // Log level selection
  document.getElementById('log-level')?.addEventListener('change', updateLogLevel);

  const agentForm = document.getElementById('agent-form');
  if (agentForm instanceof HTMLFormElement) initializeAgentEditor(agentForm);

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

function agentForm(): HTMLFormElement {
  const form = document.getElementById('agent-form');
  if (!(form instanceof HTMLFormElement)) throw new Error('Agent editor form not found');
  return form;
}

function resetAgentEditorOnClose(): void {
  editingAgentId = null;
  connectionTestGeneration += 1;
  void agentMemoryControls.show(null);
}

function setAgentModalTitle(title: string): void {
  const heading = document.getElementById('modal-title');
  if (!heading) throw new Error('Agent editor title not found');
  heading.textContent = title;
}

function openCreateModal() {
  editingAgentId = null;
  const form = agentForm();
  setAgentModalTitle('New Agent');
  renderAgentEditor(form, defaultAgentEditorState());
  void agentMemoryControls.show(null);
  setupModalFooter({
    modalId: 'agent-modal',
    onSave: saveAgent,
    onTest: testCurrentAgent,
  });
  setAgentEditorBusy(form, false);
  openModal('agent-modal', resetAgentEditorOnClose);
}

async function openEditModal(agentId: string) {
  const agent = await configStorage.getAgent(agentId);
  if (!agent) {
    showStatus('Agent not found. Reload settings and try again.', 'error');
    return;
  }

  editingAgentId = agentId;
  const form = agentForm();
  setAgentModalTitle('Edit Agent');
  renderAgentEditor(form, agentToEditorState(agent));
  void agentMemoryControls.show(agentId);
  setupModalFooter({
    modalId: 'agent-modal',
    onSave: saveAgent,
    onTest: testCurrentAgent,
    onDelete: () => {
      if (
        window.confirm(
          `Delete agent "${agent.name}"? Its Local Memory connection will be removed, but no local files will be deleted. This cannot be undone.`
        )
      ) {
        void deleteAgent(agentId);
      }
    },
    onDuplicate: duplicateAgent,
  });
  setAgentEditorBusy(form, false);
  openModal('agent-modal', resetAgentEditorOnClose);
}

async function saveAgent() {
  const form = agentForm();
  if (!form.reportValidity()) return;

  try {
    const agentData = readAgentDraft(form);
    const { apiProtocol } = agentData;

    if (editingAgentId) {
      // Provider is descriptive model metadata, not a transport selector. Editing the
      // Connection API must not silently rewrite it for proxy-routed models.
      await configStorage.updateAgent(editingAgentId, agentData);
      showStatus('Agent updated successfully!', 'success');
    } else {
      await configStorage.addAgent({
        ...agentData,
        provider: providerForApiProtocol(apiProtocol),
      });
      showStatus('Agent created successfully!', 'success');
    }

    closeModal('agent-modal');
    await renderAgents();
  } catch (error) {
    log.error('Failed to save agent:', error);
    showStatus('Failed to save agent', 'error');
  }
}

async function testCurrentAgent() {
  const form = agentForm();
  if (!form.reportValidity()) return;

  const agentData = readAgentDraft(form);
  const { apiProtocol } = agentData;
  const generation = ++connectionTestGeneration;

  setAgentEditorBusy(form, true);
  showModalStatus('agent-modal', `Testing ${protocolBadgeLabel(apiProtocol)}...`, 'info');

  try {
    // Test the exact protocol selected by the same controls Save reads.
    const message = {
      type: 'TEST_NEW_CONNECTION',
      apiProtocol,
      apiKey: agentData.apiKey,
      model: agentData.model,
      endpoint: agentData.endpoint,
    } satisfies ExtensionMessage;

    const result = await new Promise<{ success: boolean; message: string }>((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });

    if (generation !== connectionTestGeneration) return;
    const resultPrefix = `${protocolBadgeLabel(apiProtocol)}: `;
    if (!result) {
      showModalStatus('agent-modal', `${resultPrefix}no response from background script`, 'error');
    } else if (result.success) {
      showModalStatus('agent-modal', `${resultPrefix}${result.message}`, 'success');
    } else {
      showModalStatus(
        'agent-modal',
        `${resultPrefix}${result.message || 'Connection test failed'}`,
        'error'
      );
    }
  } catch {
    if (generation === connectionTestGeneration) {
      log.error('Connection test failed');
      showModalStatus('agent-modal', 'Failed to test connection', 'error');
    }
  } finally {
    if (generation === connectionTestGeneration) setAgentEditorBusy(form, false);
  }
}

async function deleteAgent(agentId: string) {
  try {
    await agentMemoryControls.removeBinding(agentId);
    await configStorage.deleteAgent(agentId);
    showStatus('Agent deleted successfully', 'success');

    closeModal('agent-modal');
    await renderAgents();
  } catch (error) {
    log.error('Failed to delete agent:', error);
    showStatus('Failed to delete agent', 'error');
  }
}

/**
 * Duplicate current agent by cloning saved state with a new name.
 * Avoids duplicating form collection logic - just clones the persisted agent.
 */
async function duplicateAgent() {
  if (!editingAgentId) return;

  try {
    const agent = await configStorage.getAgent(editingAgentId);
    if (!agent) {
      showStatus('Agent not found', 'error');
      return;
    }

    const allAgents = await configStorage.getAgents();
    const newName = generateDuplicateName(
      agent.name,
      allAgents.map((a) => a.name)
    );

    // Clone agent without id and isDefault
    const { id: _id, isDefault: _isDefault, ...agentData } = agent;
    await configStorage.addAgent({ ...agentData, name: newName, isDefault: false });

    showStatus(`Agent duplicated as "${newName}"`, 'success');
    closeModal('agent-modal');
    await renderAgents();
  } catch (error) {
    log.error('Failed to duplicate agent:', error);
    showStatus('Failed to duplicate agent', 'error');
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
  const selectedLogLevel = select.value as LogLevel;

  try {
    await configStorage.set({ logLevel: selectedLogLevel });
    showStatus(`Log level set to ${selectedLogLevel.toUpperCase()}`, 'success');
  } catch (error) {
    log.error('Failed to update log level:', error);
    showStatus('Failed to update log level', 'error');
  }
}

function showStatus(message: string, type: 'success' | 'error' | 'info', autoHide = true) {
  const statusEl = document.getElementById('status-message');
  if (!statusEl) return;

  statusEl.textContent = message;
  statusEl.className = `status-message ${type}`;
  statusEl.style.display = 'block';

  if (autoHide) {
    // Auto-hide after 3 seconds for success/info, 5 seconds for errors
    setTimeout(
      () => {
        statusEl.style.display = 'none';
      },
      type === 'error' ? 5000 : 3000
    );
  }
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
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
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
    const statuses = await remoteMCPManager.probe(mcpConfig);

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
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
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

    // Show server instructions as expandable section (if provided)
    if (status.instructions) {
      const details = document.createElement('details');
      details.className = 'mcp-server-instructions';

      const summary = document.createElement('summary');
      summary.textContent = 'Server Instructions';
      details.appendChild(summary);

      const pre = document.createElement('pre');
      pre.textContent = status.instructions;
      details.appendChild(pre);

      serverDiv.appendChild(details);
    }

    statusContent.appendChild(serverDiv);
  }
}

export {};
