/**
 * Built-in slash command implementations
 * These execute actions directly without sending to LLM
 */

import log from '../logger';
import type { SlashCommand } from '../../types';
import JSONFormatter from 'json-formatter-js';

/**
 * Create DOM element for info boxes (tools, help display)
 * Styled differently from chat messages to show system info
 */
export function createInfoBox(title: string, content: string | string[]): HTMLElement {
  const box = document.createElement('div');
  box.className = 'command-info-box';

  const titleEl = document.createElement('h3');
  titleEl.className = 'info-box-title';
  titleEl.textContent = title;
  box.appendChild(titleEl);

  const contentEl = document.createElement('div');
  contentEl.className = 'info-box-content';

  if (Array.isArray(content)) {
    const list = document.createElement('ul');
    content.forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      list.appendChild(li);
    });
    contentEl.appendChild(list);
  } else {
    contentEl.textContent = content;
  }

  box.appendChild(contentEl);
  return box;
}

/**
 * Create an interactive tools display with expandable schemas
 */
export function createToolsDisplay(
  tools: Array<{ name: string; description: string; inputSchema?: unknown }>
): HTMLElement {
  const box = document.createElement('div');
  box.className = 'command-info-box';

  const titleEl = document.createElement('h3');
  titleEl.className = 'info-box-title';
  titleEl.textContent = 'Available Tools';
  box.appendChild(titleEl);

  const contentEl = document.createElement('div');
  contentEl.className = 'info-box-content tools-list';

  if (!tools || tools.length === 0) {
    const emptyMsg = document.createElement('p');
    emptyMsg.textContent = 'No tools available for this page';
    emptyMsg.className = 'tools-empty';
    contentEl.appendChild(emptyMsg);
  } else {
    tools.forEach((tool) => {
      // Create a collapsible box for each tool
      const toolBox = document.createElement('div');
      toolBox.className = 'tool-item-box';

      // Tool header (clickable if has schema)
      const toolHeader = document.createElement('div');
      toolHeader.className = 'tool-header';
      if (tool.inputSchema) {
        toolHeader.style.cursor = 'pointer';
      }

      // Tool name in code block
      const toolName = document.createElement('code');
      toolName.className = 'tool-name';
      toolName.textContent = tool.name;
      toolHeader.appendChild(toolName);

      // Add chevron if schema exists
      if (tool.inputSchema) {
        const chevron = document.createElement('span');
        chevron.className = 'chevron';
        chevron.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.5" 
                  stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        `;
        toolHeader.appendChild(chevron);
      }

      toolBox.appendChild(toolHeader);

      // Tool description (always visible)
      const toolDesc = document.createElement('div');
      toolDesc.className = 'tool-description';
      toolDesc.textContent = tool.description;
      toolBox.appendChild(toolDesc);

      // Schema content (collapsible) if exists
      if (tool.inputSchema) {
        const schemaContent = document.createElement('div');
        schemaContent.className = 'tool-schema-content';

        // Add a label for the schema section
        const schemaLabel = document.createElement('div');
        schemaLabel.className = 'tool-schema-label';
        schemaLabel.textContent = 'Input Schema:';
        schemaContent.appendChild(schemaLabel);

        // Use JSONFormatter for rich JSON display
        const isDarkMode =
          window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

        const formatter = new JSONFormatter(tool.inputSchema, 3, {
          hoverPreviewEnabled: false,
          hoverPreviewArrayCount: 100,
          hoverPreviewFieldCount: 5,
          theme: isDarkMode ? 'dark' : '',
          animateOpen: true,
          animateClose: true,
          useToJSON: true,
          maxArrayItems: 100,
        });

        // Add wrapper for JSONFormatter output
        const jsonWrapper = document.createElement('div');
        jsonWrapper.className = 'json-formatter-wrapper tool-schema-json';
        jsonWrapper.appendChild(formatter.render());
        schemaContent.appendChild(jsonWrapper);

        toolBox.appendChild(schemaContent);

        // Toggle functionality on header click
        let isExpanded = false;
        toolHeader.addEventListener('click', () => {
          isExpanded = !isExpanded;
          if (isExpanded) {
            toolBox.classList.add('expanded');
          } else {
            toolBox.classList.remove('expanded');
          }
        });
      }

      contentEl.appendChild(toolBox);
    });
  }

  box.appendChild(contentEl);
  return box;
}

/**
 * Create grouped command display for help
 */
function createCommandsDisplay(commands: SlashCommand[]): HTMLElement {
  const container = document.createElement('div');
  container.className = 'info-box-content';

  // Separate built-in and custom commands
  const builtinCommands = commands.filter((cmd) => cmd.isBuiltin);
  const customCommands = commands.filter((cmd) => !cmd.isBuiltin);

  // Built-in commands section
  if (builtinCommands.length > 0) {
    const builtinSection = document.createElement('div');
    builtinSection.className = 'command-section';

    const builtinHeader = document.createElement('div');
    builtinHeader.className = 'command-section-header';
    builtinHeader.textContent = 'Built-in Commands';
    builtinSection.appendChild(builtinHeader);

    const builtinList = document.createElement('ul');
    builtinCommands.forEach((cmd) => {
      const li = document.createElement('li');
      li.textContent = `/${cmd.name} - ${cmd.instructions.slice(0, 100)}${cmd.instructions.length > 100 ? '...' : ''}`;
      builtinList.appendChild(li);
    });
    builtinSection.appendChild(builtinList);
    container.appendChild(builtinSection);
  }

  // Custom commands section
  if (customCommands.length > 0) {
    const customSection = document.createElement('div');
    customSection.className = 'command-section';

    const customHeader = document.createElement('div');
    customHeader.className = 'command-section-header';
    customHeader.textContent = 'Custom Commands';
    customSection.appendChild(customHeader);

    const customList = document.createElement('ul');
    customCommands.forEach((cmd) => {
      const li = document.createElement('li');
      li.textContent = `/${cmd.name} - ${cmd.instructions.slice(0, 100)}${cmd.instructions.length > 100 ? '...' : ''}`;
      customList.appendChild(li);
    });
    customSection.appendChild(customList);
    container.appendChild(customSection);
  }

  return container;
}

/**
 * Get available tools for current tab
 * Integrates with existing WebMCP system
 */
async function getCurrentTabTools(
  attachedTabId: number | null
): Promise<Array<{ name: string; description: string; inputSchema?: unknown }> | null> {
  try {
    // Use the sidebar's attached tab ID if available
    let tabId = attachedTabId;

    // Fallback to active tab if no attached tab (shouldn't happen in sidebar context)
    if (!tabId) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id || null;
    }

    if (!tabId) {
      return null;
    }

    // Request tools from background script
    const response = await chrome.runtime.sendMessage({
      type: 'WEBMCP_GET_TOOLS',
      tabId,
    });

    if (response?.success && Array.isArray(response.data)) {
      return response.data;
    }

    return [];
  } catch (error) {
    log.error('[Commands] Failed to get tools:', error);
    return null;
  }
}

/**
 * Clear chat UI and history
 * Must be called from sidebar context with access to DOM
 *
 * Note: This dispatches a custom event that the sidebar listens for
 * to trigger its clearConversation() function, which properly clears
 * the in-memory messageHistory array and resets all state.
 */
function clearChat(): void {
  // Dispatch custom event that sidebar will handle
  // Sidebar has the clearConversation() function that properly resets state
  window.dispatchEvent(new CustomEvent('clear-conversation'));
}

/**
 * Factory function to create built-in commands with sidebar context
 * Must be called from sidebar where DOM and registry are available
 */
export function createBuiltinCommands(
  registry: { getAllCommands: () => SlashCommand[] },
  attachedTabId: number | null = null
): Record<string, () => void> {
  return {
    settings: () => {
      // Open options page in new tab
      chrome.runtime.openOptionsPage();
    },

    tools: async () => {
      // Display tools in chat UI without sending to LLM
      const messagesContainer = document.getElementById('messages');
      if (!messagesContainer) {
        log.error('[Commands] Messages container not found');
        return;
      }

      const tools = await getCurrentTabTools(attachedTabId);
      const toolsBox = createToolsDisplay(tools || []);
      messagesContainer.appendChild(toolsBox);

      // Scroll to bottom
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    },

    help: () => {
      // Display all commands in chat UI without sending to LLM
      const messagesContainer = document.getElementById('messages');
      if (!messagesContainer) {
        log.error('[Commands] Messages container not found');
        return;
      }

      const allCommands = registry.getAllCommands();

      // Create help box structure without title (sections have their own headers)
      const box = document.createElement('div');
      box.className = 'command-info-box command-info-box--no-title';

      const commandsDisplay = createCommandsDisplay(allCommands);
      box.appendChild(commandsDisplay);

      messagesContainer.appendChild(box);

      // Scroll to bottom
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    },

    clear: () => {
      clearChat();
    },
  };
}
