/**
 * Command Registry manages both built-in and user-defined slash commands
 */

import log from '../logger';
import type { SlashCommand, CommandStorage } from '../../types';
import { isValidCommandName, MAX_USER_COMMAND_SIZE, validateCommandStorage } from './storage';
import { runStorageOperation } from '../storage/operation-queue';

export class CommandRegistry {
  private builtinCommands: Map<string, () => void>;
  private userCommands: Map<string, SlashCommand>;
  private storageKey = 'slashCommands';

  constructor() {
    this.builtinCommands = new Map();
    this.userCommands = new Map();
  }

  /**
   * Initialize built-in commands
   * These execute actions directly without sending to LLM
   */
  registerBuiltins(commands: Record<string, () => void>): void {
    for (const [name, action] of Object.entries(commands)) {
      this.builtinCommands.set(name.toLowerCase(), action);
    }
  }

  /**
   * Load user commands from Chrome storage
   */
  async loadUserCommands(): Promise<void> {
    try {
      await runStorageOperation(async () => {
        this.userCommands = await this.readUserCommands();
      });
    } catch {
      this.userCommands.clear();
      log.error('Failed to load user commands: INVALID_COMMAND_STORAGE');
    }
  }

  /**
   * Save a user-defined command
   * Validates uniqueness and storage limits
   */
  async saveUserCommand(command: SlashCommand): Promise<void> {
    const normalizedName = command.name.toLowerCase();

    // Validate command name
    if (!this.isValidCommandName(command.name)) {
      throw new Error(`Invalid command name: ${command.name}`);
    }

    // Check for conflicts with built-ins
    if (this.builtinCommands.has(normalizedName)) {
      throw new Error(`Cannot override built-in command: ${command.name}`);
    }

    // Validate storage size (Chrome sync limit is 100KB total)
    const commandSize = JSON.stringify(command).length;
    if (commandSize > MAX_USER_COMMAND_SIZE) {
      // 8KB per command limit
      throw new Error('Command template is too large (max 8KB)');
    }

    const savedCommand = globalThis.structuredClone({
      ...command,
      name: command.name, // Preserve original casing
      isBuiltin: false as const,
      createdAt: command.createdAt || Date.now(),
    });

    await this.mutateUserCommands((commands) => {
      commands.set(normalizedName, savedCommand);
    });
  }

  /**
   * Delete a user command
   */
  async deleteUserCommand(name: string): Promise<void> {
    const normalizedName = name.toLowerCase();

    await this.mutateUserCommands((commands) => {
      if (!commands.delete(normalizedName)) {
        throw new Error(`Command not found: ${name}`);
      }
    });
  }

  /**
   * Get a command by name (built-in or user-defined)
   * Returns either the action function or the command object
   */
  getCommand(name: string): (() => void) | SlashCommand | null {
    const normalizedName = name.toLowerCase();

    // Built-in commands take precedence
    const builtinAction = this.builtinCommands.get(normalizedName);
    if (builtinAction) {
      return builtinAction;
    }

    // Then check user commands
    return this.userCommands.get(normalizedName) || null;
  }

  /**
   * Get all available commands for display/help
   */
  getAllCommands(): SlashCommand[] {
    const allCommands: SlashCommand[] = [];

    // Add built-in commands as SlashCommand objects for consistent display
    for (const name of this.builtinCommands.keys()) {
      allCommands.push({
        name,
        instructions: this.getBuiltinDescription(name),
        isBuiltin: true,
        createdAt: 0,
      });
    }

    // Add user commands
    for (const command of this.userCommands.values()) {
      allCommands.push(command);
    }

    return allCommands.sort((a, b) => {
      // Built-ins first, then alphabetical
      if (a.isBuiltin !== b.isBuiltin) {
        return a.isBuiltin ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Check if a command name is valid
   * Must be alphanumeric with hyphens, 1-50 chars
   */
  isValidCommandName(name: string): boolean {
    return isValidCommandName(name);
  }

  /**
   * Check if a command name is available for use
   */
  isCommandNameAvailable(name: string): boolean {
    const normalizedName = name.toLowerCase();
    return !this.builtinCommands.has(normalizedName) && !this.userCommands.has(normalizedName);
  }

  /**
   * Get list of user commands only
   */
  getUserCommands(): SlashCommand[] {
    return Array.from(this.userCommands.values());
  }

  private async readUserCommands(): Promise<Map<string, SlashCommand>> {
    const result = await chrome.storage.local.get(this.storageKey);
    const storedValue = result[this.storageKey];
    const commands = new Map<string, SlashCommand>();
    if (storedValue === undefined) return commands;

    for (const command of validateCommandStorage(storedValue).userCommands) {
      commands.set(command.name.toLowerCase(), command);
    }
    return commands;
  }

  /** Mutate a fresh storage snapshot so imports and concurrent saves cannot be overwritten. */
  private async mutateUserCommands(
    mutate: (commands: Map<string, SlashCommand>) => void
  ): Promise<void> {
    try {
      await runStorageOperation(async () => {
        const commands = await this.readUserCommands();
        mutate(commands);
        const storage: CommandStorage = validateCommandStorage({
          userCommands: Array.from(commands.values()),
        });
        await chrome.storage.local.set({ [this.storageKey]: storage });
        this.userCommands = commands;
      });
    } catch (error) {
      log.error('Failed to save user commands:', error);
      throw error;
    }
  }

  /**
   * Get description for built-in commands
   */
  private getBuiltinDescription(name: string): string {
    const descriptions: Record<string, string> = {
      settings: 'Opens extension options page',
      tools: 'Lists available MCP tools for current tab',
      help: 'Shows all available commands',
      clear: 'Clears current conversation',
    };
    return descriptions[name] || 'Built-in command';
  }
}
