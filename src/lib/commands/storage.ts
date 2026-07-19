import type { CommandStorage, SlashCommand } from '../../types';

export const MAX_USER_COMMAND_SIZE = 8192;
export const BUILTIN_COMMAND_NAMES = ['settings', 'tools', 'help', 'clear'] as const;

export class CommandStorageValidationError extends Error {
  constructor() {
    super('INVALID_COMMAND_STORAGE');
    this.name = 'CommandStorageValidationError';
  }
}

export function isValidCommandName(name: string): boolean {
  return /^[a-z0-9-]{1,50}$/i.test(name);
}

export function isBuiltinCommandName(name: string): boolean {
  return BUILTIN_COMMAND_NAMES.includes(
    name.toLowerCase() as (typeof BUILTIN_COMMAND_NAMES)[number]
  );
}

/** Validate persisted/imported commands before any consumer or write sees them. */
export function validateCommandStorage(value: unknown): CommandStorage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommandStorageValidationError();
  }

  const storage = value as Record<string, unknown>;
  if (!Array.isArray(storage.userCommands)) throw new CommandStorageValidationError();

  const names = new Set<string>();
  const commands = storage.userCommands.map((value): SlashCommand => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new CommandStorageValidationError();
    }

    const command = value as Record<string, unknown>;
    if (
      typeof command.name !== 'string' ||
      !isValidCommandName(command.name) ||
      typeof command.instructions !== 'string' ||
      command.isBuiltin !== false ||
      typeof command.createdAt !== 'number' ||
      !Number.isFinite(command.createdAt) ||
      command.createdAt < 0 ||
      JSON.stringify(command).length > MAX_USER_COMMAND_SIZE
    ) {
      throw new CommandStorageValidationError();
    }

    const normalizedName = command.name.toLowerCase();
    if (names.has(normalizedName) || isBuiltinCommandName(normalizedName)) {
      throw new CommandStorageValidationError();
    }
    names.add(normalizedName);

    return { ...command } as unknown as SlashCommand;
  });

  return { userCommands: commands };
}
