/**
 * Slash commands management for options page
 */

import log from '../lib/logger';
import type { SlashCommand } from '../types';
import { CommandRegistry } from '../lib/commands/registry';
import { openModal, closeModal, setupBackdropHandler } from './modal-manager';
import { createCard, setupModalFooter } from './card-component';

// Built-in commands that cannot be overridden by users
const BUILTIN_COMMANDS = ['settings', 'tools', 'help', 'clear'];

let commandRegistry: CommandRegistry;
let editingCommandName: string | null = null;

/**
 * Initialize commands management
 */
export async function initializeCommands(): Promise<void> {
  commandRegistry = new CommandRegistry();
  await commandRegistry.loadUserCommands();
  await renderCommands();
  setupCommandEventListeners();
  setupLivePreview();
}

/**
 * Render command cards
 */
async function renderCommands(): Promise<void> {
  const commandsList = document.getElementById('commands-list');
  const noCommands = document.getElementById('no-commands');

  if (!commandsList || !noCommands) {
    log.error('Commands UI elements not found');
    return;
  }

  const commands = commandRegistry.getUserCommands();

  // Clear existing content
  commandsList.innerHTML = '';

  if (commands.length === 0) {
    commandsList.classList.add('hidden');
    noCommands.classList.remove('hidden');
    return;
  }

  commandsList.classList.remove('hidden');
  noCommands.classList.add('hidden');

  // Render command cards
  commands.forEach((command) => {
    const card = createCommandCard(command);
    commandsList.appendChild(card);
  });
}

/**
 * Create command card element
 */
function createCommandCard(command: SlashCommand): HTMLElement {
  const preview =
    command.instructions.length > 100
      ? `${command.instructions.substring(0, 100)}...`
      : command.instructions;

  return createCard({
    id: command.name,
    title: `/${command.name}`,
    subtitle: preview,
    onEdit: () => editCommand(command.name),
  });
}

/**
 * Setup event listeners for commands UI
 */
function setupCommandEventListeners(): void {
  // Create command button
  document.getElementById('create-command')?.addEventListener('click', () => {
    showCommandModal();
  });

  // Modal controls
  document
    .getElementById('command-modal-close')
    ?.addEventListener('click', () => closeModal('command-modal'));
  setupBackdropHandler('command-modal');
}

/**
 * Check for command name conflicts that HTML5 can't validate
 */
function checkCommandConflicts(name: string): string {
  // Check for conflicts with built-in commands
  if (BUILTIN_COMMANDS.includes(name.toLowerCase())) {
    return `"${name}" is a built-in command and cannot be used`;
  }

  // Check for conflicts with existing user commands
  // Only check when not in edit mode (editingCommandName would match current command)
  if (!editingCommandName || editingCommandName.toLowerCase() !== name.toLowerCase()) {
    if (!commandRegistry.isCommandNameAvailable(name)) {
      return `Command /${name} already exists`;
    }
  }

  return '';
}

/**
 * Setup live preview for command creation
 */
function setupLivePreview(): void {
  const nameInput = document.getElementById('command-name') as HTMLInputElement;
  const instructionsInput = document.getElementById('command-instructions') as HTMLTextAreaElement;
  const exampleInput = document.getElementById('example-input');
  const exampleOutput = document.getElementById('example-output');

  const updatePreview = () => {
    const name = nameInput?.value || 'command';
    const instructions = instructionsInput?.value || 'Your template here';

    if (exampleInput) {
      exampleInput.textContent = `/${name} your arguments here`;
    }

    if (exampleOutput) {
      const expanded = instructions.replace(/\$ARGUMENTS/g, 'your arguments here');
      exampleOutput.textContent = expanded;
    }
  };

  nameInput?.addEventListener('input', updatePreview);
  instructionsInput?.addEventListener('input', updatePreview);
}

/**
 * Show command creation/edit modal
 */
function showCommandModal(command?: SlashCommand): void {
  const title = document.getElementById('command-modal-title');
  const nameInput = document.getElementById('command-name') as HTMLInputElement;
  const instructionsInput = document.getElementById('command-instructions') as HTMLTextAreaElement;
  const form = document.getElementById('command-form') as HTMLFormElement;

  if (!nameInput || !instructionsInput) return;

  if (command) {
    // Edit mode
    editingCommandName = command.name;
    if (title) title.textContent = 'Edit Command';
    nameInput.value = command.name;
    nameInput.disabled = false; // Allow renaming during edit
    instructionsInput.value = command.instructions;

    // Setup modal footer with delete button for editing
    setupModalFooter({
      modalId: 'command-modal',
      onSave: saveCommand,
      onDelete: () => {
        if (window.confirm(`Delete command /${command.name}? This cannot be undone.`)) {
          deleteCommand(command.name);
        }
      },
    });
  } else {
    // Create mode - reset form to clear all validation states
    form?.reset();
    editingCommandName = null;
    if (title) title.textContent = 'Create Command';
    nameInput.disabled = false;

    // Setup modal footer without delete for new commands
    setupModalFooter({
      modalId: 'command-modal',
      onSave: saveCommand,
    });
  }

  // Update preview directly without triggering validation
  const exampleInput = document.getElementById('example-input');
  const exampleOutput = document.getElementById('example-output');
  if (exampleInput && exampleOutput) {
    const name = nameInput.value || 'command';
    const instructions = instructionsInput.value || 'Your template here';
    exampleInput.textContent = `/${name} your arguments here`;
    exampleOutput.textContent = instructions.replace(/\$ARGUMENTS/g, 'your arguments here');
  }

  openModal('command-modal', () => {
    editingCommandName = null;
  });
}

/**
 * Edit existing command
 */
async function editCommand(name: string): Promise<void> {
  const commands = commandRegistry.getUserCommands();
  const command = commands.find((c) => c.name === name);

  if (command) {
    showCommandModal(command);
  }
}

/**
 * Save command (create or update)
 */
async function saveCommand(): Promise<void> {
  const form = document.getElementById('command-form') as HTMLFormElement;
  const nameInput = document.getElementById('command-name') as HTMLInputElement;
  const instructionsInput = document.getElementById('command-instructions') as HTMLTextAreaElement;

  const name = nameInput?.value.trim();

  // Set custom validity for conflicts before validation
  if (nameInput && name) {
    const conflictError = checkCommandConflicts(name);
    nameInput.setCustomValidity(conflictError);
  } else if (nameInput) {
    // Clear custom validity for empty input
    nameInput.setCustomValidity('');
  }

  if (!form.reportValidity()) {
    return;
  }

  const instructions = instructionsInput?.value.trim();

  try {
    // If renaming, get the original command to preserve createdAt
    let originalCreatedAt = Date.now();
    if (editingCommandName) {
      const existingCommand = commandRegistry
        .getUserCommands()
        .find((c) => c.name === editingCommandName);
      if (existingCommand) {
        originalCreatedAt = existingCommand.createdAt;
      }
    }

    const command: SlashCommand = {
      name, // Use the new name (which may be same as editingCommandName)
      instructions,
      isBuiltin: false,
      createdAt: originalCreatedAt,
    };

    // If renaming (name changed), delete the old command first
    if (editingCommandName && editingCommandName.toLowerCase() !== name.toLowerCase()) {
      await commandRegistry.deleteUserCommand(editingCommandName);
    }

    await commandRegistry.saveUserCommand(command);
    await renderCommands();
    closeModal('command-modal');
    showStatus(
      `Command /${command.name} ${editingCommandName ? 'updated' : 'created'} successfully`,
      'success'
    );
  } catch (error) {
    log.error('Failed to save command:', error);
    showStatus(`Failed to save command: ${error}`, 'error');
  }
}

/**
 * Delete a command
 */
async function deleteCommand(name: string): Promise<void> {
  try {
    await commandRegistry.deleteUserCommand(name);
    await renderCommands();
    closeModal('command-modal');
    showStatus(`Command /${name} deleted successfully`, 'success');
  } catch (error) {
    log.error('Failed to delete command:', error);
    showStatus(`Failed to delete command: ${error}`, 'error');
  }
}

/**
 * Show status message
 */
function showStatus(message: string, type: 'success' | 'error'): void {
  const statusElement = document.getElementById('status-message');
  if (!statusElement) return;

  statusElement.textContent = message;
  statusElement.className = `status-message ${type}`;
  statusElement.classList.add('show');

  setTimeout(() => {
    statusElement.classList.remove('show');
  }, 3000);
}
