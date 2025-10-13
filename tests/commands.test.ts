/**
 * Tests for slash commands functionality
 *
 * Critical paths tested:
 * - Command detection and parsing
 * - Template expansion with arguments
 * - Storage integration and limits
 * - Built-in vs user command routing
 * - Name validation and conflict prevention
 * - Edge cases: escaping, empty args, unknown commands
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandRegistry } from '../src/lib/commands/registry';
import { CommandProcessor } from '../src/lib/commands/processor';
import type { SlashCommand } from '../src/types';

describe('CommandRegistry', () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new CommandRegistry();
  });

  describe('Built-in Commands', () => {
    it('should register built-in commands', () => {
      const mockAction = vi.fn();
      registry.registerBuiltins({
        test: mockAction,
        settings: vi.fn(),
      });

      const command = registry.getCommand('test');
      expect(command).toBe(mockAction);
    });

    it('should handle case-insensitive lookup for built-ins', () => {
      const mockAction = vi.fn();
      registry.registerBuiltins({ settings: mockAction });

      expect(registry.getCommand('settings')).toBe(mockAction);
      expect(registry.getCommand('SETTINGS')).toBe(mockAction);
      expect(registry.getCommand('Settings')).toBe(mockAction);
    });

    it('should prevent user commands from overriding built-ins', async () => {
      registry.registerBuiltins({ settings: vi.fn() });

      const userCommand: SlashCommand = {
        name: 'settings',
        instructions: 'My custom settings',
        isBuiltin: false,
        createdAt: Date.now(),
      };

      await expect(registry.saveUserCommand(userCommand)).rejects.toThrow(
        'Cannot override built-in command'
      );
    });
  });

  describe('User Commands', () => {
    it('should save and retrieve user commands', async () => {
      vi.mocked(chrome.storage.local.set).mockResolvedValue();

      const command: SlashCommand = {
        name: 'test-cmd',
        instructions: 'Test instruction with $ARGUMENTS',
        isBuiltin: false,
        createdAt: Date.now(),
      };

      await registry.saveUserCommand(command);

      const retrieved = registry.getCommand('test-cmd');
      expect(retrieved).toMatchObject({
        name: 'test-cmd',
        instructions: 'Test instruction with $ARGUMENTS',
        isBuiltin: false,
      });
    });

    it('should handle case-insensitive lookup for user commands', async () => {
      vi.mocked(chrome.storage.local.set).mockResolvedValue();

      const command: SlashCommand = {
        name: 'MyCommand',
        instructions: 'Test',
        isBuiltin: false,
        createdAt: Date.now(),
      };

      await registry.saveUserCommand(command);

      // Should find with different casing
      expect(registry.getCommand('mycommand')).toBeTruthy();
      expect(registry.getCommand('MYCOMMAND')).toBeTruthy();
      expect(registry.getCommand('MyCommand')).toBeTruthy();
    });

    it('should load user commands from storage', async () => {
      const storedCommands: SlashCommand[] = [
        {
          name: 'cmd1',
          instructions: 'Instruction 1',
          isBuiltin: false,
          createdAt: Date.now(),
        },
        {
          name: 'cmd2',
          instructions: 'Instruction 2',
          isBuiltin: false,
          createdAt: Date.now(),
        },
      ];

      vi.mocked(chrome.storage.local.get).mockResolvedValue({
        slashCommands: { userCommands: storedCommands },
      } as any);

      await registry.loadUserCommands();

      expect(registry.getCommand('cmd1')).toBeTruthy();
      expect(registry.getCommand('cmd2')).toBeTruthy();
    });

    it('should handle storage load failures gracefully', async () => {
      vi.mocked(chrome.storage.local.get).mockRejectedValue(new Error('Storage error'));

      // Should not throw
      await expect(registry.loadUserCommands()).resolves.not.toThrow();

      // Should continue with empty commands
      expect(registry.getUserCommands()).toHaveLength(0);
    });

    it('should delete user commands', async () => {
      vi.mocked(chrome.storage.local.set).mockResolvedValue();

      const command: SlashCommand = {
        name: 'to-delete',
        instructions: 'Delete me',
        isBuiltin: false,
        createdAt: Date.now(),
      };

      await registry.saveUserCommand(command);
      expect(registry.getCommand('to-delete')).toBeTruthy();

      await registry.deleteUserCommand('to-delete');
      expect(registry.getCommand('to-delete')).toBeNull();
    });

    it('should throw when deleting non-existent command', async () => {
      await expect(registry.deleteUserCommand('non-existent')).rejects.toThrow('Command not found');
    });

    it('should update existing command', async () => {
      vi.mocked(chrome.storage.local.set).mockResolvedValue();

      const original: SlashCommand = {
        name: 'update-me',
        instructions: 'Original',
        isBuiltin: false,
        createdAt: Date.now(),
      };

      await registry.saveUserCommand(original);

      const updated: SlashCommand = {
        name: 'update-me',
        instructions: 'Updated instructions',
        isBuiltin: false,
        createdAt: original.createdAt,
      };

      await registry.saveUserCommand(updated);

      const retrieved = registry.getCommand('update-me') as SlashCommand;
      expect(retrieved.instructions).toBe('Updated instructions');
    });
  });

  describe('Command Name Validation', () => {
    it('should accept valid command names', () => {
      expect(registry.isValidCommandName('simple')).toBe(true);
      expect(registry.isValidCommandName('with-dashes')).toBe(true);
      expect(registry.isValidCommandName('with123numbers')).toBe(true);
      expect(registry.isValidCommandName('a')).toBe(true);
    });

    it('should reject invalid command names', () => {
      expect(registry.isValidCommandName('')).toBe(false);
      expect(registry.isValidCommandName('with spaces')).toBe(false);
      expect(registry.isValidCommandName('with_underscores')).toBe(false);
      expect(registry.isValidCommandName('with.dots')).toBe(false);
      expect(registry.isValidCommandName('with@symbols')).toBe(false);
      expect(registry.isValidCommandName('a'.repeat(51))).toBe(false); // Too long
    });

    it('should throw on save with invalid name', async () => {
      const invalidCommand: SlashCommand = {
        name: 'invalid name with spaces',
        instructions: 'Test',
        isBuiltin: false,
        createdAt: Date.now(),
      };

      await expect(registry.saveUserCommand(invalidCommand)).rejects.toThrow(
        'Invalid command name'
      );
    });
  });

  describe('Storage Limits', () => {
    it('should reject commands exceeding 8KB size', async () => {
      const largeCommand: SlashCommand = {
        name: 'huge',
        instructions: 'x'.repeat(9000), // Over 8KB
        isBuiltin: false,
        createdAt: Date.now(),
      };

      await expect(registry.saveUserCommand(largeCommand)).rejects.toThrow(
        'Command template is too large'
      );
    });

    it('should handle storage write failures', async () => {
      vi.mocked(chrome.storage.local.set).mockRejectedValue(new Error('Storage error'));

      const command: SlashCommand = {
        name: 'fail',
        instructions: 'Test',
        isBuiltin: false,
        createdAt: Date.now(),
      };

      await expect(registry.saveUserCommand(command)).rejects.toThrow('Storage error');
    });
  });

  describe('getAllCommands', () => {
    it('should return both built-in and user commands', async () => {
      vi.mocked(chrome.storage.local.set).mockResolvedValue();

      registry.registerBuiltins({
        settings: vi.fn(),
        help: vi.fn(),
      });

      await registry.saveUserCommand({
        name: 'custom',
        instructions: 'Custom command',
        isBuiltin: false,
        createdAt: Date.now(),
      });

      const allCommands = registry.getAllCommands();

      expect(allCommands).toHaveLength(3);
      expect(allCommands.filter((c) => c.isBuiltin)).toHaveLength(2);
      expect(allCommands.filter((c) => !c.isBuiltin)).toHaveLength(1);
    });

    it('should sort with built-ins first, then alphabetical', async () => {
      vi.mocked(chrome.storage.local.set).mockResolvedValue();

      registry.registerBuiltins({
        zulu: vi.fn(),
        alpha: vi.fn(),
      });

      await registry.saveUserCommand({
        name: 'zebra',
        instructions: 'Z command',
        isBuiltin: false,
        createdAt: Date.now(),
      });

      await registry.saveUserCommand({
        name: 'apple',
        instructions: 'A command',
        isBuiltin: false,
        createdAt: Date.now(),
      });

      const allCommands = registry.getAllCommands();

      // Built-ins first
      expect(allCommands[0].isBuiltin).toBe(true);
      expect(allCommands[1].isBuiltin).toBe(true);

      // Then user commands alphabetically
      expect(allCommands[2].name).toBe('apple');
      expect(allCommands[3].name).toBe('zebra');
    });
  });

  describe('isCommandNameAvailable', () => {
    it('should return false for built-in commands', () => {
      registry.registerBuiltins({ settings: vi.fn() });
      expect(registry.isCommandNameAvailable('settings')).toBe(false);
    });

    it('should return false for existing user commands', async () => {
      vi.mocked(chrome.storage.local.set).mockResolvedValue();

      await registry.saveUserCommand({
        name: 'taken',
        instructions: 'Test',
        isBuiltin: false,
        createdAt: Date.now(),
      });

      expect(registry.isCommandNameAvailable('taken')).toBe(false);
    });

    it('should return true for available names', () => {
      expect(registry.isCommandNameAvailable('available')).toBe(true);
    });
  });
});

describe('CommandProcessor', () => {
  let registry: CommandRegistry;
  let processor: CommandProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new CommandRegistry();
    processor = new CommandProcessor(registry);
  });

  describe('Command Detection', () => {
    it('should detect command at start of input', () => {
      const result = processor.detectCommand('/test arg1 arg2');
      expect(result).toEqual({
        command: 'test',
        args: 'arg1 arg2',
      });
    });

    it('should detect command without arguments', () => {
      const result = processor.detectCommand('/help');
      expect(result).toEqual({
        command: 'help',
        args: '',
      });
    });

    it('should return null for input not starting with /', () => {
      expect(processor.detectCommand('not a command')).toBeNull();
      expect(processor.detectCommand('some /command in middle')).toBeNull();
    });

    it('should return null for escaped commands', () => {
      expect(processor.detectCommand('\\/not-a-command')).toBeNull();
    });

    it('should trim arguments but preserve internal spaces', () => {
      const result = processor.detectCommand('/test   multiple   spaces   ');
      expect(result?.args).toBe('multiple   spaces');
    });

    it('should handle commands with special characters in args', () => {
      const result = processor.detectCommand('/test arg with @special #chars!');
      expect(result?.args).toBe('arg with @special #chars!');
    });
  });

  describe('Template Expansion', () => {
    it('should replace $ARGUMENTS with provided args', () => {
      const template = 'Review this code focusing on: $ARGUMENTS';
      const expanded = processor.expandTemplate(template, 'security and performance');
      expect(expanded).toBe('Review this code focusing on: security and performance');
    });

    it('should handle multiple $ARGUMENTS in template', () => {
      const template = 'Start: $ARGUMENTS, End: $ARGUMENTS';
      const expanded = processor.expandTemplate(template, 'test');
      expect(expanded).toBe('Start: test, End: test');
    });

    it('should handle empty arguments', () => {
      const template = 'Review this code focusing on: $ARGUMENTS';
      const expanded = processor.expandTemplate(template, '');
      expect(expanded).toBe('Review this code focusing on: ');
    });

    it('should preserve template without $ARGUMENTS', () => {
      const template = 'Fixed instruction without variables';
      const expanded = processor.expandTemplate(template, 'ignored args');
      expect(expanded).toBe('Fixed instruction without variables');
    });

    it('should handle $ARGUMENTS at start of template', () => {
      const template = '$ARGUMENTS is the focus';
      const expanded = processor.expandTemplate(template, 'Security');
      expect(expanded).toBe('Security is the focus');
    });

    it('should handle $ARGUMENTS at end of template', () => {
      const template = 'Focus on $ARGUMENTS';
      const expanded = processor.expandTemplate(template, 'performance');
      expect(expanded).toBe('Focus on performance');
    });

    it('should be case-insensitive: $arguments (lowercase)', () => {
      const template = 'Review this code for $arguments issues';
      const expanded = processor.expandTemplate(template, 'security');
      expect(expanded).toBe('Review this code for security issues');
    });

    it('should be case-insensitive: $Arguments (mixed case)', () => {
      const template = 'Focus on $Arguments please';
      const expanded = processor.expandTemplate(template, 'performance');
      expect(expanded).toBe('Focus on performance please');
    });

    it('should be case-insensitive: $ArGuMeNtS (random case)', () => {
      const template = 'Test with $ArGuMeNtS here';
      const expanded = processor.expandTemplate(template, 'data');
      expect(expanded).toBe('Test with data here');
    });

    it('should replace all occurrences regardless of case', () => {
      const template = 'Start: $ARGUMENTS, middle: $arguments, end: $Arguments';
      const expanded = processor.expandTemplate(template, 'test');
      expect(expanded).toBe('Start: test, middle: test, end: test');
    });
  });

  describe('Command Processing', () => {
    it('should process built-in action commands', async () => {
      const mockAction = vi.fn();
      registry.registerBuiltins({ clear: mockAction });

      const result = await processor.process('/clear');

      expect(result).toEqual({
        type: 'action',
        action: mockAction,
      });
    });

    it('should process user text commands', async () => {
      vi.mocked(chrome.storage.local.set).mockResolvedValue();

      await registry.saveUserCommand({
        name: 'pr-review',
        instructions: 'Review focusing on: $ARGUMENTS',
        isBuiltin: false,
        createdAt: Date.now(),
      });

      const result = await processor.process('/pr-review security');

      expect(result).toEqual({
        type: 'text',
        content: 'Review focusing on: security',
      });
    });

    it('should return null for unknown commands', async () => {
      const result = await processor.process('/unknown-command');
      expect(result).toBeNull();
    });

    it('should handle escaped commands by removing escape', async () => {
      const result = await processor.process('\\/not-a-command');

      expect(result).toEqual({
        type: 'text',
        content: '/not-a-command',
      });
    });

    it('should return null for regular text', async () => {
      const result = await processor.process('Just regular text');
      expect(result).toBeNull();
    });

    it('should prioritize built-in over user commands (sanity check)', async () => {
      const mockAction = vi.fn();
      registry.registerBuiltins({ settings: mockAction });

      // Try to add user command with same name (should fail in registry)
      await expect(
        registry.saveUserCommand({
          name: 'settings',
          instructions: 'Custom',
          isBuiltin: false,
          createdAt: Date.now(),
        })
      ).rejects.toThrow();

      const result = await processor.process('/settings');
      expect(result?.type).toBe('action');
    });
  });

  describe('Command Validation', () => {
    it('should validate command pattern', () => {
      expect(processor.isValidCommandPattern('/valid-name')).toBe(true);
      expect(processor.isValidCommandPattern('/a')).toBe(true);
      expect(processor.isValidCommandPattern('/valid with args')).toBe(true); // 'valid' is valid command name
    });

    it('should reject invalid patterns', () => {
      expect(processor.isValidCommandPattern('no-slash')).toBe(false);
      expect(processor.isValidCommandPattern('/invalid_name')).toBe(false); // underscore not allowed
      expect(processor.isValidCommandPattern('/with.dots')).toBe(false);
      expect(processor.isValidCommandPattern('/')).toBe(false); // empty command name
    });
  });

  describe('Command Suggestions', () => {
    it('should return matching commands for partial input', async () => {
      vi.mocked(chrome.storage.local.set).mockResolvedValue();

      registry.registerBuiltins({
        settings: vi.fn(),
        search: vi.fn(),
        help: vi.fn(),
      });

      await registry.saveUserCommand({
        name: 'security-review',
        instructions: 'Test',
        isBuiltin: false,
        createdAt: Date.now(),
      });

      const suggestions = processor.getSuggestions('/se');

      expect(suggestions).toContain('/settings');
      expect(suggestions).toContain('/search');
      expect(suggestions).toContain('/security-review');
      expect(suggestions).not.toContain('/help');
    });

    it('should return empty array for non-slash input', () => {
      const suggestions = processor.getSuggestions('no slash');
      expect(suggestions).toEqual([]);
    });

    it('should handle case-insensitive matching', async () => {
      vi.mocked(chrome.storage.local.set).mockResolvedValue();

      await registry.saveUserCommand({
        name: 'TestCommand',
        instructions: 'Test',
        isBuiltin: false,
        createdAt: Date.now(),
      });

      const suggestions = processor.getSuggestions('/test');
      expect(suggestions).toContain('/TestCommand');
    });

    it('should return all commands for just /', async () => {
      vi.mocked(chrome.storage.local.set).mockResolvedValue();

      registry.registerBuiltins({ help: vi.fn() });

      await registry.saveUserCommand({
        name: 'custom',
        instructions: 'Test',
        isBuiltin: false,
        createdAt: Date.now(),
      });

      const suggestions = processor.getSuggestions('/');
      expect(suggestions.length).toBeGreaterThan(0);
    });
  });
});

describe('Integration Tests', () => {
  let registry: CommandRegistry;
  let processor: CommandProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new CommandRegistry();
    processor = new CommandProcessor(registry);
  });

  it('should complete full user command flow', async () => {
    vi.mocked(chrome.storage.local.set).mockResolvedValue();

    // Create command
    await registry.saveUserCommand({
      name: 'code-review',
      instructions: 'You are an expert developer. Review this code for $ARGUMENTS issues.',
      isBuiltin: false,
      createdAt: Date.now(),
    });

    // Use command
    const result = await processor.process('/code-review security and performance');

    expect(result?.type).toBe('text');
    expect(result?.content).toBe(
      'You are an expert developer. Review this code for security and performance issues.'
    );
  });

  it('should complete full built-in command flow', async () => {
    const mockClearAction = vi.fn();
    registry.registerBuiltins({ clear: mockClearAction });

    const result = await processor.process('/clear');

    expect(result?.type).toBe('action');
    expect(result?.action).toBe(mockClearAction);

    // Execute action
    result?.action?.();
    expect(mockClearAction).toHaveBeenCalled();
  });

  it('should handle command update flow', async () => {
    vi.mocked(chrome.storage.local.set).mockResolvedValue();

    // Create initial command
    await registry.saveUserCommand({
      name: 'review',
      instructions: 'Old instructions',
      isBuiltin: false,
      createdAt: Date.now(),
    });

    // Update it
    await registry.saveUserCommand({
      name: 'review',
      instructions: 'New instructions with $ARGUMENTS',
      isBuiltin: false,
      createdAt: Date.now(),
    });

    // Use updated command
    const result = await processor.process('/review focus areas');

    expect(result?.content).toBe('New instructions with focus areas');
  });

  it('should handle command deletion flow', async () => {
    vi.mocked(chrome.storage.local.set).mockResolvedValue();

    // Create command
    await registry.saveUserCommand({
      name: 'temp',
      instructions: 'Temporary command',
      isBuiltin: false,
      createdAt: Date.now(),
    });

    // Verify it works
    let result = await processor.process('/temp');
    expect(result).not.toBeNull();

    // Delete it
    await registry.deleteUserCommand('temp');

    // Verify it no longer works
    result = await processor.process('/temp');
    expect(result).toBeNull();
  });

  it('should handle command rename flow', async () => {
    vi.mocked(chrome.storage.local.set).mockResolvedValue();

    // Create initial command
    const createdAt = Date.now();
    await registry.saveUserCommand({
      name: 'old-name',
      instructions: 'Test instructions with $ARGUMENTS',
      isBuiltin: false,
      createdAt,
    });

    // Verify it works
    let result = await processor.process('/old-name test');
    expect(result?.content).toBe('Test instructions with test');

    // Rename by deleting old and creating new (simulates UI flow)
    await registry.deleteUserCommand('old-name');
    await registry.saveUserCommand({
      name: 'new-name',
      instructions: 'Test instructions with $ARGUMENTS',
      isBuiltin: false,
      createdAt, // Preserve original timestamp
    });

    // Verify old name no longer works
    result = await processor.process('/old-name test');
    expect(result).toBeNull();

    // Verify new name works
    result = await processor.process('/new-name test');
    expect(result?.content).toBe('Test instructions with test');

    // Verify timestamp was preserved
    const renamedCommand = registry.getCommand('new-name') as SlashCommand;
    expect(renamedCommand.createdAt).toBe(createdAt);
  });

  it('should maintain case-insensitive behavior throughout', async () => {
    vi.mocked(chrome.storage.local.set).mockResolvedValue();

    await registry.saveUserCommand({
      name: 'MixedCase',
      instructions: 'Test $ARGUMENTS',
      isBuiltin: false,
      createdAt: Date.now(),
    });

    // All variations should work
    const variations = ['/mixedcase', '/MIXEDCASE', '/MixedCase', '/mIxEdCaSe'];

    for (const variation of variations) {
      const result = await processor.process(`${variation} arg`);
      expect(result?.content).toBe('Test arg');
    }
  });

  it('should handle empty registry gracefully', async () => {
    const result = await processor.process('/anything');
    expect(result).toBeNull();

    const suggestions = processor.getSuggestions('/any');
    expect(suggestions).toEqual([]);
  });
});

describe('Edge Cases', () => {
  let registry: CommandRegistry;
  let processor: CommandProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new CommandRegistry();
    processor = new CommandProcessor(registry);
  });

  it('should handle command with only spaces as argument', async () => {
    vi.mocked(chrome.storage.local.set).mockResolvedValue();

    await registry.saveUserCommand({
      name: 'test',
      instructions: 'Args: $ARGUMENTS',
      isBuiltin: false,
      createdAt: Date.now(),
    });

    const result = await processor.process('/test    ');
    // Arguments are trimmed
    expect(result?.content).toBe('Args: ');
  });

  it('should handle very long command names at limit', async () => {
    vi.mocked(chrome.storage.local.set).mockResolvedValue();

    const longName = 'a'.repeat(50); // Max is 50

    await registry.saveUserCommand({
      name: longName,
      instructions: 'Test',
      isBuiltin: false,
      createdAt: Date.now(),
    });

    const result = await processor.process(`/${longName}`);
    expect(result).not.toBeNull();
  });

  it('should handle commands with numbers and hyphens', async () => {
    vi.mocked(chrome.storage.local.set).mockResolvedValue();

    await registry.saveUserCommand({
      name: 'test-123-cmd',
      instructions: 'Test',
      isBuiltin: false,
      createdAt: Date.now(),
    });

    const result = await processor.process('/test-123-cmd');
    expect(result).not.toBeNull();
  });

  it('should preserve exact casing in stored command name', async () => {
    vi.mocked(chrome.storage.local.set).mockResolvedValue();

    await registry.saveUserCommand({
      name: 'MyCommand',
      instructions: 'Test',
      isBuiltin: false,
      createdAt: Date.now(),
    });

    const allCommands = registry.getAllCommands();
    const cmd = allCommands.find((c) => c.name === 'MyCommand');
    expect(cmd?.name).toBe('MyCommand'); // Not lowercased
  });

  it('should handle unicode in arguments', async () => {
    vi.mocked(chrome.storage.local.set).mockResolvedValue();

    await registry.saveUserCommand({
      name: 'translate',
      instructions: 'Translate: $ARGUMENTS',
      isBuiltin: false,
      createdAt: Date.now(),
    });

    const result = await processor.process('/translate 你好世界 🌍');
    expect(result?.content).toBe('Translate: 你好世界 🌍');
  });

  it('should handle newlines in arguments', async () => {
    vi.mocked(chrome.storage.local.set).mockResolvedValue();

    await registry.saveUserCommand({
      name: 'multiline',
      instructions: 'Process: $ARGUMENTS',
      isBuiltin: false,
      createdAt: Date.now(),
    });

    const result = await processor.process('/multiline line1\nline2');
    expect(result?.content).toBe('Process: line1\nline2');
  });

  it('should handle storage quota exceeded error', async () => {
    vi.mocked(chrome.storage.local.set).mockRejectedValue({
      message: 'QUOTA_BYTES_PER_ITEM quota exceeded',
    });

    await expect(
      registry.saveUserCommand({
        name: 'test',
        instructions: 'x'.repeat(10000),
        isBuiltin: false,
        createdAt: Date.now(),
      })
    ).rejects.toThrow();
  });

  it('should handle concurrent command saves', async () => {
    vi.mocked(chrome.storage.local.set).mockResolvedValue();

    const promises = Array.from({ length: 5 }, (_, i) =>
      registry.saveUserCommand({
        name: `concurrent-${i}`,
        instructions: 'Test',
        isBuiltin: false,
        createdAt: Date.now(),
      })
    );

    await Promise.all(promises);

    // All should be saved
    expect(registry.getUserCommands()).toHaveLength(5);
  });
});
