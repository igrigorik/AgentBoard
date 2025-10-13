/**
 * Command Processor handles detection and expansion of slash commands
 */

import type { ProcessedCommand, SlashCommand } from '../../types';
import { CommandRegistry } from './registry';

export class CommandProcessor {
  constructor(private registry: CommandRegistry) {}

  /**
   * Detect if input starts with a slash command
   * Returns command name and arguments if found
   */
  detectCommand(input: string): { command: string; args: string } | null {
    // Check for escape character
    if (input.startsWith('\\')) {
      return null;
    }

    // Commands must start with /
    if (!input.startsWith('/')) {
      return null;
    }

    // Parse command and arguments
    const spaceIndex = input.indexOf(' ');
    if (spaceIndex === -1) {
      // Command without arguments
      return {
        command: input.slice(1),
        args: '',
      };
    }

    return {
      command: input.slice(1, spaceIndex),
      args: input.slice(spaceIndex + 1).trim(),
    };
  }

  /**
   * Expand a template by replacing $ARGUMENTS with provided args
   * Case-insensitive: matches $ARGUMENTS, $arguments, $Arguments, etc.
   */
  expandTemplate(template: string, args: string): string {
    // Case-insensitive replacement - $ARGUMENTS becomes the args string
    return template.replace(/\$ARGUMENTS/gi, args);
  }

  /**
   * Process input and return either expanded text or action to execute
   */
  async process(input: string): Promise<ProcessedCommand | null> {
    // Handle escaped commands (e.g., \\/command becomes /command)
    if (input.startsWith('\\')) {
      return {
        type: 'text',
        content: input.slice(1),
      };
    }

    // Detect command
    const detected = this.detectCommand(input);
    if (!detected) {
      return null; // Not a command
    }

    // Look up command in registry
    const command = this.registry.getCommand(detected.command);
    if (!command) {
      // Command not found - return as regular text
      // This allows users to type /unknown without errors
      return null;
    }

    // Handle built-in commands (actions)
    if (typeof command === 'function') {
      return {
        type: 'action',
        action: command,
      };
    }

    // Handle user-defined commands (text expansion)
    const slashCommand = command as SlashCommand;
    const expandedText = this.expandTemplate(slashCommand.instructions, detected.args);

    return {
      type: 'text',
      content: expandedText,
    };
  }

  /**
   * Check if input is a valid slash command pattern
   * Used for UI hints/validation
   */
  isValidCommandPattern(input: string): boolean {
    if (!input.startsWith('/')) {
      return false;
    }

    const commandPart = input.slice(1).split(' ')[0];
    return this.registry.isValidCommandName(commandPart);
  }

  /**
   * Get command suggestions based on partial input
   * Returns matching command names for future autocomplete
   */
  getSuggestions(partialInput: string): string[] {
    if (!partialInput.startsWith('/')) {
      return [];
    }

    const partial = partialInput.slice(1).toLowerCase();
    const allCommands = this.registry.getAllCommands();

    return allCommands
      .filter((cmd) => cmd.name.toLowerCase().startsWith(partial))
      .map((cmd) => `/${cmd.name}`);
  }
}
