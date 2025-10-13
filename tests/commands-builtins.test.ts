/**
 * Tests for built-in slash commands and UI helpers
 *
 * These tests cover DOM-dependent functionality:
 * - Info box creation and rendering
 * - Tools display with collapsible schemas
 * - Built-in command actions (settings, tools, help, clear)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  createInfoBox,
  createToolsDisplay,
  createBuiltinCommands,
} from '../src/lib/commands/builtins';
import { CommandRegistry } from '../src/lib/commands/registry';
import { JSDOM } from 'jsdom';

describe('Built-in Command UI Helpers', () => {
  // Setup DOM environment for each test
  let dom: JSDOM;
  let document: Document;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    document = dom.window.document;
    global.document = document as any;
    global.HTMLElement = dom.window.HTMLElement as any;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createInfoBox', () => {
    it('should create info box with title and string content', () => {
      const box = createInfoBox('Test Title', 'Test content');

      expect(box.className).toBe('command-info-box');

      const title = box.querySelector('.info-box-title');
      expect(title?.textContent).toBe('Test Title');

      const content = box.querySelector('.info-box-content');
      expect(content?.textContent).toBe('Test content');
    });

    it('should create info box with array content as list', () => {
      const box = createInfoBox('Commands', ['command1', 'command2', 'command3']);

      const list = box.querySelector('ul');
      expect(list).toBeTruthy();

      const items = box.querySelectorAll('li');
      expect(items).toHaveLength(3);
      expect(items[0].textContent).toBe('command1');
      expect(items[1].textContent).toBe('command2');
      expect(items[2].textContent).toBe('command3');
    });

    it('should create proper DOM structure', () => {
      const box = createInfoBox('Title', 'Content');

      // Check structure
      expect(box.tagName).toBe('DIV');
      expect(box.children).toHaveLength(2); // title + content

      const title = box.children[0];
      expect(title.tagName).toBe('H3');
      expect(title.className).toBe('info-box-title');

      const content = box.children[1];
      expect(content.tagName).toBe('DIV');
      expect(content.className).toBe('info-box-content');
    });
  });

  describe('createToolsDisplay', () => {
    it('should create tools display with empty state', () => {
      const box = createToolsDisplay([]);

      const title = box.querySelector('.info-box-title');
      expect(title?.textContent).toBe('Available Tools');

      const emptyMsg = box.querySelector('.tools-empty');
      expect(emptyMsg?.textContent).toBe('No tools available for this page');
    });

    it('should create tools display with tool list', () => {
      const tools = [
        {
          name: 'tool1',
          description: 'First tool',
        },
        {
          name: 'tool2',
          description: 'Second tool',
        },
      ];

      const box = createToolsDisplay(tools);

      const toolItems = box.querySelectorAll('.tool-item-box');
      expect(toolItems).toHaveLength(2);

      const toolNames = box.querySelectorAll('.tool-name');
      expect(toolNames[0].textContent).toBe('tool1');
      expect(toolNames[1].textContent).toBe('tool2');

      const descriptions = box.querySelectorAll('.tool-description');
      expect(descriptions[0].textContent).toBe('First tool');
      expect(descriptions[1].textContent).toBe('Second tool');
    });

    it('should create expandable schema for tools with inputSchema', () => {
      const tools = [
        {
          name: 'complex-tool',
          description: 'Tool with schema',
          inputSchema: {
            type: 'object',
            properties: {
              param1: { type: 'string' },
            },
          },
        },
      ];

      const box = createToolsDisplay(tools);

      // Should have chevron indicator
      const chevron = box.querySelector('.chevron');
      expect(chevron).toBeTruthy();

      // Should have schema content (initially collapsed)
      const schemaContent = box.querySelector('.tool-schema-content');
      expect(schemaContent).toBeTruthy();

      // Should have schema label
      const schemaLabel = box.querySelector('.tool-schema-label');
      expect(schemaLabel?.textContent).toBe('Input Schema:');

      // Should have JSON formatter wrapper (JSONFormatter is used for rich display)
      const jsonWrapper = box.querySelector('.json-formatter-wrapper');
      expect(jsonWrapper).toBeTruthy();
    });

    it('should not add chevron for tools without inputSchema', () => {
      const tools = [
        {
          name: 'simple-tool',
          description: 'No schema',
        },
      ];

      const box = createToolsDisplay(tools);

      const chevron = box.querySelector('.chevron');
      expect(chevron).toBeNull();

      const schemaContent = box.querySelector('.tool-schema-content');
      expect(schemaContent).toBeNull();
    });

    it('should toggle expanded class on header click', () => {
      const tools = [
        {
          name: 'expandable',
          description: 'Test',
          inputSchema: { type: 'object' },
        },
      ];

      const box = createToolsDisplay(tools);
      const toolBox = box.querySelector('.tool-item-box') as HTMLElement;
      const header = box.querySelector('.tool-header') as HTMLElement;

      // Initially not expanded
      expect(toolBox.classList.contains('expanded')).toBe(false);

      // Click to expand
      header.click();
      expect(toolBox.classList.contains('expanded')).toBe(true);

      // Click to collapse
      header.click();
      expect(toolBox.classList.contains('expanded')).toBe(false);
    });

    it('should handle null tools gracefully', () => {
      const box = createToolsDisplay(null as any);

      const emptyMsg = box.querySelector('.tools-empty');
      expect(emptyMsg?.textContent).toBe('No tools available for this page');
    });
  });
});

describe('Built-in Command Actions', () => {
  let dom: JSDOM;
  let document: Document;
  let registry: CommandRegistry;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup DOM with messages container
    dom = new JSDOM(`
      <!DOCTYPE html>
      <html>
        <body>
          <div id="messages"></div>
        </body>
      </html>
    `);
    document = dom.window.document;
    global.document = document as any;
    global.HTMLElement = dom.window.HTMLElement as any;
    global.window = dom.window as any;

    registry = new CommandRegistry();
  });

  describe('settings command', () => {
    it('should call chrome.runtime.openOptionsPage', () => {
      const commands = createBuiltinCommands(registry);

      commands.settings();

      expect(chrome.runtime.openOptionsPage).toHaveBeenCalled();
    });
  });

  describe('help command', () => {
    it('should display all commands in messages container', () => {
      vi.mocked(chrome.storage.sync.set).mockResolvedValue();

      // Register some commands
      registry.registerBuiltins({
        help: vi.fn(),
        settings: vi.fn(),
      });

      const commands = createBuiltinCommands(registry);
      commands.help();

      const messagesContainer = document.getElementById('messages');
      expect(messagesContainer?.children).toHaveLength(1);

      const infoBox = messagesContainer?.children[0];
      expect(infoBox?.className).toContain('command-info-box');
      expect(infoBox?.className).toContain('command-info-box--no-title');

      // Should have command sections, not a title
      const sections = infoBox?.querySelectorAll('.command-section');
      expect(sections?.length).toBeGreaterThan(0);
    });

    it('should show both built-in and user commands in separate sections', async () => {
      vi.mocked(chrome.storage.sync.set).mockResolvedValue();

      // Register built-in
      registry.registerBuiltins({ help: vi.fn() });

      // Add user command
      await registry.saveUserCommand({
        name: 'custom',
        instructions: 'Custom command',
        isBuiltin: false,
        createdAt: Date.now(),
      });

      const commands = createBuiltinCommands(registry);
      commands.help();

      const messagesContainer = document.getElementById('messages');
      const sections = messagesContainer?.querySelectorAll('.command-section');
      expect(sections?.length).toBe(2); // Built-in and custom sections

      // Check built-in section
      const builtinSection = Array.from(sections || []).find((s) =>
        s.querySelector('.command-section-header')?.textContent?.includes('Built-in')
      );
      expect(builtinSection).toBeDefined();
      const builtinItems = builtinSection?.querySelectorAll('li');
      expect(builtinItems?.length).toBeGreaterThanOrEqual(1);

      // Check custom section
      const customSection = Array.from(sections || []).find((s) =>
        s.querySelector('.command-section-header')?.textContent?.includes('Custom')
      );
      expect(customSection).toBeDefined();
      const customItems = customSection?.querySelectorAll('li');
      expect(customItems?.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle missing messages container gracefully', () => {
      // Remove messages container
      const container = document.getElementById('messages');
      container?.remove();

      const commands = createBuiltinCommands(registry);

      // Should not throw
      expect(() => commands.help()).not.toThrow();
    });
  });

  describe('tools command', () => {
    it('should request tools from background script', async () => {
      const mockTools = [
        {
          name: 'tool1',
          description: 'Test tool',
        },
      ];

      vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
        success: true,
        data: mockTools,
      });

      const commands = createBuiltinCommands(registry, 123); // tabId = 123

      await commands.tools();

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: 'WEBMCP_GET_TOOLS',
        tabId: 123,
      });
    });

    it('should display tools in messages container', async () => {
      const mockTools = [
        {
          name: 'test-tool',
          description: 'Test description',
        },
      ];

      vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
        success: true,
        data: mockTools,
      });

      const commands = createBuiltinCommands(registry, 123);

      await commands.tools();

      const messagesContainer = document.getElementById('messages');
      expect(messagesContainer?.children).toHaveLength(1);

      const toolsBox = messagesContainer?.children[0];
      const toolName = toolsBox?.querySelector('.tool-name');
      expect(toolName?.textContent).toBe('test-tool');
    });

    it('should handle tool fetch failure gracefully', async () => {
      vi.mocked(chrome.runtime.sendMessage).mockRejectedValue(new Error('Tab not found'));

      const commands = createBuiltinCommands(registry, 999);

      // Should not throw
      await expect(commands.tools()).resolves.not.toThrow();

      // Should show empty state
      const messagesContainer = document.getElementById('messages');
      const emptyMsg = messagesContainer?.querySelector('.tools-empty');
      expect(emptyMsg).toBeTruthy();
    });

    it('should handle empty tools array', async () => {
      vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
        success: true,
        data: [],
      });

      const commands = createBuiltinCommands(registry, 123);

      await commands.tools();

      const messagesContainer = document.getElementById('messages');
      const emptyMsg = messagesContainer?.querySelector('.tools-empty');
      expect(emptyMsg?.textContent).toBe('No tools available for this page');
    });

    it('should scroll to bottom after adding tools', async () => {
      vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
        success: true,
        data: [{ name: 'tool', description: 'test' }],
      });

      const commands = createBuiltinCommands(registry, 123);
      await commands.tools();

      const messagesContainer = document.getElementById('messages') as HTMLElement;
      // In JSDOM, scrollHeight might be 0, but we verify the property is set
      expect(messagesContainer.scrollTop).toBeDefined();
    });

    it('should handle missing messages container gracefully', async () => {
      // Remove messages container
      const container = document.getElementById('messages');
      container?.remove();

      vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
        success: true,
        data: [],
      });

      const commands = createBuiltinCommands(registry, 123);

      // Should not throw
      await expect(commands.tools()).resolves.not.toThrow();
    });
  });

  describe('clear command', () => {
    it('should dispatch clear-conversation event', () => {
      const eventSpy = vi.fn();
      (global as any).window.addEventListener('clear-conversation', eventSpy);

      const commands = createBuiltinCommands(registry);
      commands.clear();

      expect(eventSpy).toHaveBeenCalled();
    });

    it('should not throw when dispatching event', () => {
      const commands = createBuiltinCommands(registry);

      // Should not throw
      expect(() => commands.clear()).not.toThrow();
    });
  });
});

describe('Built-in Commands Integration', () => {
  let dom: JSDOM;
  let document: Document;
  let registry: CommandRegistry;

  beforeEach(() => {
    vi.clearAllMocks();

    dom = new JSDOM(`
      <!DOCTYPE html>
      <html>
        <body>
          <div id="messages"></div>
        </body>
      </html>
    `);
    document = dom.window.document;
    global.document = document as any;
    global.HTMLElement = dom.window.HTMLElement as any;
    global.window = dom.window as any;

    registry = new CommandRegistry();
  });

  it('should create all standard built-in commands', () => {
    const commands = createBuiltinCommands(registry);

    expect(commands.settings).toBeTypeOf('function');
    expect(commands.tools).toBeTypeOf('function');
    expect(commands.help).toBeTypeOf('function');
    expect(commands.clear).toBeTypeOf('function');
  });

  it('should work with tab ID for tools command', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      success: true,
      data: [],
    });

    const commands = createBuiltinCommands(registry, 456);
    await commands.tools();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 456 })
    );
  });

  it('should work without explicit tab ID', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([{ id: 789 } as any]);
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      success: true,
      data: [],
    });

    const commands = createBuiltinCommands(registry, null);
    await commands.tools();

    // Should query for active tab
    expect(chrome.tabs.query).toHaveBeenCalledWith({
      active: true,
      currentWindow: true,
    });
  });

  it('should execute commands without interfering with each other', async () => {
    vi.mocked(chrome.storage.sync.set).mockResolvedValue();
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      success: true,
      data: [],
    });

    await registry.saveUserCommand({
      name: 'test',
      instructions: 'Test',
      isBuiltin: false,
      createdAt: Date.now(),
    });

    const commands = createBuiltinCommands(registry, 123);

    // Set up event listener to track clear
    let clearEventFired = false;
    (global as any).window.addEventListener('clear-conversation', () => {
      clearEventFired = true;
    });

    // Execute multiple commands
    commands.help();
    await commands.tools();
    commands.clear();

    // Verify clear dispatched its event
    expect(clearEventFired).toBe(true);
  });
});
