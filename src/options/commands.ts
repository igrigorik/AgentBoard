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
 * Setup live preview for command creation
 */
function setupLivePreview(): void {
  const nameInput = document.getElementById('command-name') as HTMLInputElement;
  const instructionsInput = document.getElementById('command-instructions') as HTMLTextAreaElement;
  const exampleInput = document.getElementById('example-input');
  const exampleOutput = document.getElementById('example-output');
  const errorElement = document.getElementById('command-name-error');
  const saveButton = document.getElementById('save-command') as HTMLButtonElement;

  const validateCommandName = (name: string): { valid: boolean; error?: string } => {
    if (!name) {
      return { valid: false, error: 'Command name is required' };
    }

    // Check for slashes
    if (name.includes('/')) {
      return {
        valid: false,
        error: 'Command names cannot contain slashes. The slash is added automatically.',
      };
    }

    // Check for spaces
    if (name.includes(' ')) {
      return { valid: false, error: 'Command names cannot contain spaces. Use hyphens instead.' };
    }

    // Check for valid characters (lowercase letters, numbers, hyphens)
    if (!/^[a-z0-9-]+$/.test(name)) {
      return { valid: false, error: 'Use only lowercase letters, numbers, and hyphens' };
    }

    // Check length
    if (name.length > 50) {
      return { valid: false, error: 'Command name must be 50 characters or less' };
    }

    // Check for conflicts with built-in commands first (independent of registry)
    if (BUILTIN_COMMANDS.includes(name.toLowerCase())) {
      return { valid: false, error: `"${name}" is a built-in command and cannot be used` };
    }

    // Check for conflicts with existing user commands
    // Only check when not in edit mode (editingCommandName would match current command)
    if (!editingCommandName || editingCommandName.toLowerCase() !== name.toLowerCase()) {
      if (!commandRegistry.isCommandNameAvailable(name)) {
        return { valid: false, error: `Command /${name} already exists` };
      }
    }

    return { valid: true };
  };

  const updateValidationState = () => {
    const name = nameInput?.value.trim() || '';
    const instructions = instructionsInput?.value.trim() || '';
    const validation = validateCommandName(name);

    if (nameInput && !nameInput.disabled) {
      if (name && !validation.valid) {
        nameInput.classList.add('invalid');
        if (errorElement) {
          errorElement.textContent = validation.error || '';
          errorElement.classList.add('show');
        }
        // Always disable save button when validation fails
        if (saveButton) {
          saveButton.disabled = true;
        }
      } else {
        nameInput.classList.remove('invalid');
        if (errorElement) {
          errorElement.textContent = '';
          errorElement.classList.remove('show');
        }
        // Enable save button only when both name and instructions are valid
        if (saveButton) {
          saveButton.disabled = !name || !instructions;
        }
      }
    }
  };

  const updatePreview = () => {
    const name = nameInput?.value || 'command';
    const instructions = instructionsInput?.value || 'Your template here';

    // Update validation state
    updateValidationState();

    if (exampleInput) {
      exampleInput.textContent = `/${name} your arguments here`;
    }

    if (exampleOutput) {
      const expanded = instructions.replace(/\$ARGUMENTS/g, 'your arguments here');
      exampleOutput.textContent = expanded;
    }
  };

  nameInput?.addEventListener('input', updatePreview);
  instructionsInput?.addEventListener('input', () => {
    updatePreview();
    // Also update save button state when instructions change
    updateValidationState();
  });

  // Also validate on blur for better UX
  nameInput?.addEventListener('blur', updateValidationState);
}

/**
 * Show command creation/edit modal
 */
function showCommandModal(command?: SlashCommand): void {
  const title = document.getElementById('command-modal-title');
  const nameInput = document.getElementById('command-name') as HTMLInputElement;
  const instructionsInput = document.getElementById('command-instructions') as HTMLTextAreaElement;
  const errorElement = document.getElementById('command-name-error');

  if (!nameInput || !instructionsInput) return;

  // Clear any previous validation errors
  nameInput.classList.remove('invalid');
  if (errorElement) {
    errorElement.textContent = '';
    errorElement.classList.remove('show');
  }

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
    // Create mode
    editingCommandName = null;
    if (title) title.textContent = 'Create Command';
    nameInput.value = '';
    nameInput.disabled = false;
    instructionsInput.value = '';

    // Setup modal footer without delete for new commands
    setupModalFooter({
      modalId: 'command-modal',
      onSave: saveCommand,
    });
  }

  // Trigger preview update
  nameInput.dispatchEvent(new Event('input'));

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
  const nameInput = document.getElementById('command-name') as HTMLInputElement;
  const instructionsInput = document.getElementById('command-instructions') as HTMLTextAreaElement;

  const name = nameInput?.value.trim();
  const instructions = instructionsInput?.value.trim();

  if (!name || !instructions) {
    showStatus('Please fill in all required fields', 'error');
    return;
  }

  // Validate command name format
  if (!commandRegistry.isValidCommandName(name)) {
    const errorElement = document.getElementById('command-name-error');
    const nameInput = document.getElementById('command-name') as HTMLInputElement;

    if (nameInput) {
      nameInput.classList.add('invalid');
      nameInput.focus();
    }

    if (errorElement) {
      let errorMessage = 'Invalid command name. ';
      if (name.includes('/')) {
        errorMessage += 'Do not include slashes - they are added automatically.';
      } else if (name.includes(' ')) {
        errorMessage += 'Spaces are not allowed. Use hyphens instead.';
      } else {
        errorMessage += 'Use only lowercase letters, numbers, and hyphens.';
      }
      errorElement.textContent = errorMessage;
      errorElement.classList.add('show');
    }

    showStatus('Please fix the command name errors', 'error');
    return;
  }

  // Check for built-in command conflicts first
  if (BUILTIN_COMMANDS.includes(name.toLowerCase())) {
    showStatus(`Cannot use built-in command name: ${name}`, 'error');
    return;
  }

  // Re-validate availability (for new commands only) in case state changed
  if (!editingCommandName && !commandRegistry.isCommandNameAvailable(name)) {
    showStatus(`Command /${name} already exists`, 'error');
    return;
  }

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
