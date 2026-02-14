/**
 * Background service worker for Chrome extension
 * Handles extension lifecycle, message passing, command registration, and AI streaming
 */

import log from '../lib/logger';
import { AIClient } from '../lib/ai/client';
import { ConfigStorage, type StorageConfig } from '../lib/storage/config';
import { getTabManager } from '../lib/webmcp/lifecycle';
import { getToolRegistry } from '../lib/webmcp/tool-registry';
import type { CoreMessage } from 'ai';
import type {
  ExtensionMessage,
  PortMessage,
  WebMCPCallToolMessage,
  WebMCPGetToolsMessage,
} from '../types/index';

interface StreamingConnection {
  port: chrome.runtime.Port;
  isStreaming: boolean;
}

// AI client and streaming management
const aiClient = AIClient.getInstance();
const configStorage = ConfigStorage.getInstance();
const activeStreams = new Map<string, StreamingConnection>();

// WebMCP tab management
const webmcp = getTabManager();

// Log available agents for debugging
async function logAvailableAgents() {
  try {
    const agents = await aiClient.getAvailableAgents();
    log.info(
      '[Background] Available agents:',
      agents.map((a) => `${a.name} (${a.provider})`)
    );
  } catch (error) {
    log.error('[Background] Failed to get available agents:', error);
  }
}

// Create or recreate context menu - needs to happen on every service worker start
async function setupContextMenu() {
  try {
    // Remove existing menu items first to avoid duplicates
    await chrome.contextMenus.removeAll();

    // Create context menu
    chrome.contextMenus.create(
      {
        id: 'ai-assistant-context',
        title: 'Ask AI Assistant',
        contexts: ['selection'],
      },
      () => {
        if (chrome.runtime.lastError) {
          log.error('[Background] Failed to create context menu:', chrome.runtime.lastError);
        } else {
          log.debug('[Background] Context menu created successfully');
        }
      }
    );
  } catch (error) {
    log.error('[Background] Error setting up context menu:', error);
  }
}

// Extension installation/update lifecycle
chrome.runtime.onInstalled.addListener(async (details) => {
  log.info('[Background] Extension installed/updated:', details.reason);

  // Set default configuration on first install
  if (details.reason === 'install') {
    // Use the default config from ConfigStorage (single source of truth)
    const defaultConfig = await configStorage.get();
    chrome.storage.local.set({
      config: defaultConfig,
    });
  }

  // Log available agents after installation/update
  logAvailableAgents();
});

// Setup context menu and log agents on service worker startup
logAvailableAgents();
setupContextMenu();

// Configure side panel behavior - DON'T auto-open on click since we need to set path first
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch((error) => {
  log.error('[Background] Failed to set panel behavior:', error);
});

/**
 * Ensure a tab-specific side panel is configured before opening
 * @param tabId - The tab ID to attach the panel to
 */
async function ensureTabPanel(tabId: number): Promise<void> {
  // Use the built path (relative to extension root)
  const path = `src/sidebar/index.html#tab=${tabId}`;
  try {
    await chrome.sidePanel.setOptions({
      tabId,
      path,
      enabled: true,
    });
    log.debug(`[Background] Side panel configured for tab ${tabId} with path: ${path}`);

    // Store sidebar binding in session storage for persistence
    await chrome.storage.session.set({
      [`sidebar_tab_${tabId}`]: {
        tabId,
        timestamp: Date.now(),
      },
    });
  } catch (error) {
    log.error(`[Background] Failed to configure side panel for tab ${tabId}:`, error);
    throw error;
  }
}

/**
 * Ensure WebMCP scripts are injected when sidebar opens
 * @param tabId - The tab ID to inject scripts into
 */
async function ensureWebMCPReady(tabId: number): Promise<void> {
  try {
    await webmcp.ensureContentScriptReady(tabId);
    log.debug(`[Background] WebMCP scripts ready for tab ${tabId}`);
  } catch (error) {
    log.error(`[Background] Failed to inject WebMCP scripts for tab ${tabId}:`, error);
    // Non-fatal - don't block sidebar opening
  }
}

/**
 * Get the bound tab ID for a sidebar instance
 * @param sender - The message sender (should be a sidebar)
 * @returns The bound tab ID or null if not found
 */
async function getBoundTabIdForSidebar(
  sender: chrome.runtime.MessageSender
): Promise<number | null> {
  // 1. Try URL hash
  if (sender.url) {
    const match = sender.url.match(/#tab=(\d+)/);
    if (match) {
      const tabId = parseInt(match[1]);
      // Verify tab still exists
      try {
        await chrome.tabs.get(tabId);
        return tabId;
      } catch {
        // Tab no longer exists
        log.warn(`[Background] Tab ${tabId} from URL hash no longer exists`);
      }
    }
  }

  // 2. Try session storage
  const stored = await chrome.storage.session.get();
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith('sidebar_tab_') && value && typeof value === 'object') {
      const data = value as { tabId: number; timestamp: number };
      if (data.tabId) {
        // Verify tab still exists
        try {
          await chrome.tabs.get(data.tabId);
          return data.tabId;
        } catch {
          // Tab gone, clean up
          await chrome.storage.session.remove(key);
        }
      }
    }
  }

  return null;
}

/**
 * Helper to send context selection to sidebar
 */
function sendContextSelection(tabId: number, text: string | undefined): void {
  if (!text) return;

  // Send selected text to sidebar after a short delay to ensure it's loaded
  setTimeout(() => {
    chrome.runtime.sendMessage(
      {
        type: 'CONTEXT_SELECTION',
        text,
        tabId, // Include tabId for message filtering
      } as const,
      () => {
        if (chrome.runtime.lastError) {
          log.debug(
            'Could not send selection to sidebar (might not be loaded yet):',
            chrome.runtime.lastError
          );
        } else {
          log.debug('Selection sent to sidebar for tab:', tabId);
        }
      }
    );
  }, 500);
}

// Debug: Check what commands are registered
chrome.commands.getAll((commands) => {
  log.debug('Registered commands:', commands);
  commands.forEach((cmd) => {
    log.debug(`Command: ${cmd.name}, Shortcut: ${cmd.shortcut}, Description: ${cmd.description}`);
  });
});

// Handle keyboard shortcut command
chrome.commands.onCommand.addListener((command, tab) => {
  log.debug('Received command:', command, 'Tab:', tab);
  if (command === 'toggle-sidebar') {
    if (tab?.id) {
      const tabId = tab.id;
      log.debug('Using tab from command listener:', tabId);

      // Try to open immediately (synchronously) to preserve user gesture
      chrome.sidePanel.open({ tabId }, () => {
        if (chrome.runtime.lastError) {
          log.debug('Panel not configured, configuring now:', chrome.runtime.lastError.message);

          // Configure and retry
          ensureTabPanel(tabId)
            .then(() => {
              chrome.sidePanel.open({ tabId }, () => {
                if (chrome.runtime.lastError) {
                  log.error('Still failed after configuration:', chrome.runtime.lastError);
                } else {
                  log.debug('Panel opened after configuration');
                }
              });
            })
            .catch((error) => {
              log.error('Failed to configure panel for command:', error);
            });
        } else {
          log.debug('Panel opened immediately from command');

          // Ensure configuration for next time
          ensureTabPanel(tabId).catch(() => {});
        }
      });
    } else {
      // No tab provided, use async approach
      log.debug('No tab provided in command, using async approach');
      handleSidebarToggle().catch((error) => {
        log.error('Failed to handle toggle-sidebar command:', error);
      });
    }
  }
});

// Handle action button click - MUST open synchronously to preserve user gesture
chrome.action.onClicked.addListener((tab) => {
  if (tab?.id) {
    const tabId = tab.id;

    // Try to open immediately (synchronously) - panel might already be configured
    chrome.sidePanel.open({ tabId }, () => {
      if (chrome.runtime.lastError) {
        log.debug('Panel not configured yet, configuring now:', chrome.runtime.lastError.message);

        // Configure the panel and try again
        ensureTabPanel(tabId)
          .then(() => {
            // Try opening again after configuration
            chrome.sidePanel.open({ tabId }, () => {
              if (chrome.runtime.lastError) {
                log.error('Still failed to open after configuration:', chrome.runtime.lastError);
              } else {
                log.debug('Panel opened after configuration for tab:', tabId);

                // Inject WebMCP scripts after opening
                ensureWebMCPReady(tabId);
              }
            });
          })
          .catch((error) => {
            log.error('Failed to configure panel:', error);
          });
      } else {
        log.debug('Panel opened immediately for tab:', tabId);

        // Ensure it's configured for next time (non-blocking)
        ensureTabPanel(tabId).catch(() => {});

        // Inject WebMCP scripts after opening
        ensureWebMCPReady(tabId);
      }
    });
  }
});

// Message handler for communication with sidebar and options
chrome.runtime.onMessage.addListener((request: ExtensionMessage, sender, sendResponse) => {
  log.debug('Background received message:', request.type);

  switch (request.type) {
    case 'GET_CONFIG':
      chrome.storage.local.get(['config'], (result) => {
        sendResponse(result.config || {});
      });
      return true; // Keep channel open for async response

    case 'SAVE_CONFIG':
      chrome.storage.local.set({ config: request.config }, async () => {
        // Config saved - agents will be loaded on-demand
        sendResponse({ success: true });
      });
      return true;

    case 'WEBMCP_SCRIPTS_UPDATED':
      // Hot reload: Re-inject user scripts into all tabs
      log.debug('[Background] Received script update notification, triggering hot reload');
      webmcp
        .reinjectAllUserScripts()
        .then(() => {
          log.debug('[Background] Hot reload completed');
          sendResponse({ success: true });
        })
        .catch((error) => {
          log.error('[Background] Hot reload failed:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true; // Keep channel open for async response

    case 'TEST_CONNECTION':
      // Test agent connection
      (async () => {
        try {
          const agentId = request.agentId;
          const result = await aiClient.testConnection(agentId);
          sendResponse(result);
        } catch (error) {
          sendResponse({
            success: false,
            message: error instanceof Error ? error.message : 'Test failed',
          });
        }
      })();
      return true;

    case 'TEST_NEW_CONNECTION':
      // Test new agent connection with provided details
      aiClient
        .testConnectionWithDetails({
          provider: request.provider,
          apiKey: request.apiKey,
          model: request.model,
          endpoint: request.endpoint,
        })
        .then((result) => {
          sendResponse(result);
        })
        .catch((error) => {
          log.error('[Background] TEST_NEW_CONNECTION error:', error);
          sendResponse({
            success: false,
            message: error instanceof Error ? error.message : 'Test failed',
          });
        });
      return true;

    case 'PING':
      sendResponse({ pong: true });
      return false;

    case 'CANCEL_STREAM': {
      // Cancel active streaming
      aiClient.cancelStream();
      const connectionId = request.connectionId;
      if (connectionId && activeStreams.has(connectionId)) {
        const connection = activeStreams.get(connectionId);
        if (connection) {
          connection.isStreaming = false;
          activeStreams.delete(connectionId);
        }
      }
      sendResponse({ success: true });
      return false;
    }

    case 'WEBMCP_CALL_TOOL': {
      // Handle WebMCP tool calls from sidebar or AI execution
      log.debug(`[Background] Handling WEBMCP_CALL_TOOL from ${sender.url || 'unknown'}`);

      (async () => {
        let responseData: { success: boolean; error?: string; result?: unknown } = {
          success: false,
          error: 'Unknown error',
        };

        try {
          const {
            tabId: providedTabId,
            toolName,
            args,
            originalTabId,
          } = request as WebMCPCallToolMessage & { originalTabId?: number };

          log.debug(`[Background] Tool call request:`, {
            toolName,
            providedTabId,
            originalTabId,
            args,
          });

          // Determine the correct tab to execute the tool in
          let tabId: number | undefined = providedTabId;

          // If no tabId provided, try to get from sidebar binding
          if (!tabId && sender.url?.includes('sidebar')) {
            tabId = (await getBoundTabIdForSidebar(sender)) ?? undefined;
            log.debug(`[Background] Using sidebar bound tab: ${tabId}`);
          }

          // If still no tabId, try the original tab where tool was registered
          if (!tabId && originalTabId) {
            // Check if we still have a connection to that tab
            const hasConnection = webmcp.getAllRegistries().has(originalTabId);
            if (hasConnection) {
              tabId = originalTabId;
              log.debug(`[Background] Using original registration tab: ${tabId}`);
            }
          }

          // Last resort: try to find any tab with the tool available
          if (!tabId) {
            const registries = webmcp.getAllRegistries();
            for (const [tid, registry] of registries) {
              if (registry.tools.some((t) => t.name === toolName)) {
                tabId = tid;
                log.debug(`[Background] Found tool in tab: ${tabId}`);
                break;
              }
            }
          }

          if (!tabId) {
            const errorMsg = `No active tab found with tool "${toolName}". Make sure the page with this tool is still open.`;
            log.error(`[Background] ${errorMsg}`);
            responseData = { success: false, error: errorMsg };
          } else {
            log.debug(`[Background] Calling tool ${toolName} in tab ${tabId}`);
            const result = await webmcp.callTool(tabId, toolName, args);
            log.debug(`[Background] Tool ${toolName} returned:`, result);
            responseData = { success: true, result };
          }
        } catch (error) {
          log.error(`[Background] Tool call error:`, error);
          responseData = {
            success: false,
            error: error instanceof Error ? error.message : 'Tool call failed',
          };
        }

        log.debug(`[Background] Sending response:`, responseData);
        sendResponse(responseData);
      })();
      return true; // Async response
    }

    case 'WEBMCP_GET_TOOLS': {
      // Get available tools from unified registry with original schemas
      (async () => {
        await toolsReady;
        const { tabId: providedTabId } = request as WebMCPGetToolsMessage;

        // Get tab ID - either provided or from sidebar binding
        let tabId = providedTabId;
        if (!tabId && sender.url?.includes('sidebar')) {
          tabId = (await getBoundTabIdForSidebar(sender)) ?? undefined;
        }

        // If we have a tab ID but no tools registered (SW hibernation recovery),
        // request tools from the page and wait for response
        if (tabId && !webmcp.getToolRegistry(tabId)) {
          log.debug(`[Background] No tools cached for tab ${tabId}, requesting from page`);
          try {
            // Wait for actual tools/listChanged response
            await webmcp.requestToolsAndWait(tabId);
            log.debug(`[Background] Tools received for tab ${tabId}`);
          } catch (error) {
            log.error(`[Background] Failed to get tools for tab ${tabId}:`, error);
            // Continue anyway - will return system tools only
          }
        }

        const toolsArray: Array<{ name: string; description: string; inputSchema?: unknown }> = [];

        // Get WebMCP tools only from the current tab (not all tabs)
        // Each tab has its own URL-filtered set of tools
        if (tabId) {
          const currentTabRegistry = webmcp.getToolRegistry(tabId);
          if (currentTabRegistry) {
            for (const tool of currentTabRegistry.tools) {
              toolsArray.push({
                name: tool.name,
                description: tool.description || 'No description available',
                inputSchema: tool.inputSchema || null,
              });
            }
          }
        }

        // Also get system/remote MCP tools from unified registry
        // Use getToolsForTab to get tab-scoped tools + global (remote/system) tools
        const unifiedRegistry = getToolRegistry();
        const scopedTools = tabId
          ? unifiedRegistry.getToolsForTab(tabId)
          : unifiedRegistry.getAllTools();

        // Add any MCP/remote/system tools not already in the list
        for (const [name, tool] of Object.entries(scopedTools)) {
          if (!toolsArray.some((t) => t.name === name)) {
            toolsArray.push({
              name,
              description: tool.description || 'No description available',
              inputSchema: null, // MCP tools use Zod schemas, hard to convert back
            });
          }
        }

        sendResponse({ success: true, data: toolsArray });
      })();
      return true; // Now async to support getBoundTabIdForSidebar
    }

    default:
      log.debug('Unknown message type:', request.type);
      return false; // No async response needed
  }
});

async function handleSidebarToggle() {
  // This is now only used for keyboard shortcuts where we need to query the active tab
  try {
    // Get current active tab
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!activeTab?.id) {
      log.error('No active tab found when trying to toggle sidebar');
      return;
    }

    log.debug('Attempting to open sidebar for tab:', activeTab.id, 'URL:', activeTab.url);

    // Configure panel first
    await ensureTabPanel(activeTab.id);

    // CRITICAL: For keyboard shortcuts, we might need to use the callback version instead of await
    // The sidePanel API has timing issues with async/await in keyboard shortcut context
    chrome.sidePanel.open({ tabId: activeTab.id }, () => {
      if (chrome.runtime.lastError) {
        log.error('Failed to open sidebar from keyboard shortcut:', chrome.runtime.lastError);
        // No windowId fallback - we want strict tab-specific behavior
      } else {
        log.debug('Sidebar opened successfully for tab:', activeTab.id);
      }
    });
  } catch (error) {
    log.error('Error in handleSidebarToggle:', error);
    // Check for specific error types
    if (error instanceof Error) {
      log.error('Error details:', error.message, error.stack);
    }
  }
}

// Handle context menu clicks - must be synchronous for sidePanel API
chrome.contextMenus.onClicked.addListener((info, tab) => {
  log.debug('Context menu clicked:', info.menuItemId, 'Tab:', tab?.id);

  if (info.menuItemId === 'ai-assistant-context') {
    if (!info.selectionText) {
      log.debug('No text selected for context menu');
      return;
    }

    // Open sidebar immediately in response to user gesture
    if (tab?.id) {
      const tabId = tab.id;
      log.debug('Opening sidebar from context menu for tab:', tabId);

      // Try to open immediately (synchronously) to preserve user gesture
      chrome.sidePanel.open({ tabId }, () => {
        if (chrome.runtime.lastError) {
          log.debug('Panel not configured, configuring now:', chrome.runtime.lastError.message);

          // Configure and retry
          ensureTabPanel(tabId)
            .then(() => {
              chrome.sidePanel.open({ tabId }, () => {
                if (chrome.runtime.lastError) {
                  log.error('Failed to open sidebar from context menu:', chrome.runtime.lastError);
                  return;
                }

                // Send selected text to sidebar
                sendContextSelection(tabId, info.selectionText);
              });
            })
            .catch((error) => {
              log.error('Failed to configure panel for context menu:', error);
            });
        } else {
          log.debug('Panel opened immediately from context menu');

          // Ensure configuration for next time
          ensureTabPanel(tabId).catch(() => {});

          // Send selected text to sidebar
          sendContextSelection(tabId, info.selectionText);
        }
      });
    } else {
      log.error('No tab ID available for context menu action');
    }
  }
});

// Pre-configure panel for new tabs to avoid timing issues
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.id) {
    try {
      await ensureTabPanel(tab.id);
      log.debug('Pre-configured panel for new tab:', tab.id);
    } catch (error) {
      // Non-critical - panel will be configured on first click
      log.debug('Could not pre-configure panel for tab:', tab.id, error);
    }
  }
});

// Monitor tab changes to pre-configure sidebar
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // Pre-configure panel for this tab to ensure correct path when/if user opens it
  try {
    await ensureTabPanel(activeInfo.tabId);
  } catch (error) {
    log.debug('Could not pre-configure panel for activated tab:', activeInfo.tabId, error);
  }
});

// Handle long-lived connections for streaming
chrome.runtime.onConnect.addListener((port) => {
  log.debug('[Background] Port connected:', port.name);
  if (port.name.startsWith('ai-stream-')) {
    const connectionId = port.name;
    log.debug('[Background] AI stream connection established:', connectionId);
    activeStreams.set(connectionId, { port, isStreaming: false });

    port.onMessage.addListener(async (msg: PortMessage) => {
      log.debug('[Background] Received message on port:', msg.type, msg);
      if (msg.type === 'STREAM_CHAT') {
        const connection = activeStreams.get(connectionId);
        if (!connection) {
          log.error('[Background] Connection not found:', connectionId);
          return;
        }

        connection.isStreaming = true;
        log.debug('[Background] Starting stream for agent:', msg.agentId, 'tab:', msg.tabId);

        try {
          await toolsReady;
          const { agentId, tabId, messages } = msg;

          // Ensure the agent is available
          if (!(await aiClient.isAgentAvailable(agentId))) {
            log.debug('[Background] Agent not available or not configured properly');
            throw new Error('Agent not configured. Please add API key in settings.');
          }
          log.debug('[Background] Agent is ready');

          // Convert messages to CoreMessage format
          const coreMessages: CoreMessage[] = messages.map(
            (m) =>
              ({
                role: m.role,
                content: m.content,
              }) as CoreMessage
          );

          log.debug(
            '[Background] Calling streamChat with messages:',
            coreMessages,
            'for tab:',
            tabId
          );
          await aiClient.streamChat(agentId, coreMessages, tabId, {
            // Text block callbacks for interleaved display
            onTextBlockStart: (blockId) => {
              if (connection.isStreaming) {
                port.postMessage({
                  type: 'STREAM_TEXT_BLOCK_START',
                  blockId,
                  messageId: globalThis.crypto.randomUUID(),
                });
              }
            },
            onTextBlockChunk: (blockId, chunk) => {
              if (connection.isStreaming) {
                port.postMessage({
                  type: 'STREAM_TEXT_BLOCK_CHUNK',
                  blockId,
                  chunk,
                  messageId: globalThis.crypto.randomUUID(),
                });
              }
            },
            onTextBlockEnd: (blockId) => {
              if (connection.isStreaming) {
                port.postMessage({
                  type: 'STREAM_TEXT_BLOCK_END',
                  blockId,
                  messageId: globalThis.crypto.randomUUID(),
                });
              }
            },
            onReasoningStart: () => {
              if (connection.isStreaming) {
                log.debug('[Background] Reasoning started');
                port.postMessage({
                  type: 'STREAM_REASONING_START',
                  messageId: globalThis.crypto.randomUUID(),
                });
              }
            },
            onReasoningChunk: (chunk) => {
              if (connection.isStreaming) {
                port.postMessage({
                  type: 'STREAM_REASONING_CHUNK',
                  chunk,
                  messageId: globalThis.crypto.randomUUID(),
                });
              }
            },
            onReasoningEnd: (usage) => {
              if (connection.isStreaming) {
                log.debug('[Background] Reasoning ended', usage);
                port.postMessage({
                  type: 'STREAM_REASONING_END',
                  usage,
                  messageId: globalThis.crypto.randomUUID(),
                });
              }
            },
            onToolCall: (toolCall) => {
              if (connection.isStreaming) {
                port.postMessage({
                  type: 'STREAM_TOOL_CALL',
                  toolCall,
                  messageId: globalThis.crypto.randomUUID(), // Generate message ID for tracking
                });
              }
            },
            onToolResult: (result) => {
              if (connection.isStreaming) {
                port.postMessage({
                  type: 'STREAM_TOOL_RESULT',
                  toolCallId: result.id,
                  output: result.output,
                  status: result.status,
                  error: result.error,
                  messageId: globalThis.crypto.randomUUID(), // Generate message ID for tracking
                });
              }
            },
            onFinish: (fullText, metadata) => {
              if (connection.isStreaming) {
                port.postMessage({
                  type: 'STREAM_COMPLETE',
                  fullResponse: fullText,
                  toolsChanged: metadata?.toolsChanged || false,
                });
                connection.isStreaming = false;
              }
            },
            onError: (error) => {
              log.error('[Background] Stream error from AI client:', error);
              const errorMessage =
                error.message ||
                error.toString() ||
                'Streaming failed - no error details available';

              port.postMessage({
                type: 'STREAM_ERROR',
                error: errorMessage,
              });
              connection.isStreaming = false;
            },
          });
        } catch (error) {
          log.error('[Background] Caught error in stream handler:', error);
          port.postMessage({
            type: 'STREAM_ERROR',
            error: error instanceof Error ? error.message : 'Stream failed',
          });
          connection.isStreaming = false;
        }
      }
    });

    port.onDisconnect.addListener(() => {
      // Clean up connection
      const connection = activeStreams.get(connectionId);
      if (connection?.isStreaming) {
        aiClient.cancelStream();
      }
      activeStreams.delete(connectionId);
    });
  }
});

// Listen for config changes from Options page
configStorage.onChange(async (newConfig: StorageConfig) => {
  await toolsReady; // Ensure initial load completes before reload
  const agents = await aiClient.getAvailableAgents();
  log.debug(
    '[Background] Config updated - available agents:',
    agents.map((a) => `${a.name} (${a.provider})`)
  );

  const toolRegistry = getToolRegistry();

  // Re-register system tools if builtin script states changed
  // This handles enable/disable of fetch_url tool
  if (newConfig.builtinScripts !== undefined) {
    log.debug('[Background] Re-registering system tools after builtin config change');
    await toolRegistry.registerSystemTools();
  }

  // Reload remote MCP tools
  log.debug('[Background] Reloading MCP tools after config change');
  await toolRegistry.loadRemoteTools();
});

// Initialization gate — handlers that need tools await this to avoid
// race between async MCP connection and immediate message handlers
const toolsReady = (async () => {
  const toolRegistry = getToolRegistry();
  await toolRegistry.registerSystemTools();
  await toolRegistry.loadRemoteTools();
  log.debug('[Background] Tool registry initialized');
})();

export {};
