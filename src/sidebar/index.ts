/**
 * Sidebar main entry point
 * Handles chat UI, message management, AI streaming, and provider switching
 */

import log from '../lib/logger';
import './styles.css';
import type { ChatMessage, ToolCall, MessageContent, MessagePart } from '../types';
import { ConfigStorage, type AgentConfig } from '../lib/storage/config';
import { ToolCallBox } from './ToolCallBox';
import { ReasoningBox } from './ReasoningBox';
import { TextBox } from './TextBox';
import { StreamingMarkdownRenderer } from './StreamingMarkdownRenderer';
import { CommandRegistry, CommandProcessor, createBuiltinCommands } from '../lib/commands';

// Streaming session interface to encapsulate all streaming state
interface StreamingSession {
  port: chrome.runtime.Port;
  currentReasoningBox?: ReasoningBox; // Currently streaming reasoning box
  reasoningBoxes: ReasoningBox[]; // All reasoning boxes in chronological order
  currentTextBox?: TextBox; // Currently streaming text box
  toolCalls: Map<string, ToolCallBox>; // Tool calls can execute in parallel
}

// DOM elements
const messagesContainer = document.getElementById('messages') as HTMLDivElement;
const messageInput = document.getElementById('message-input') as HTMLTextAreaElement;
const sendButton = document.getElementById('send-button') as HTMLButtonElement;
const agentSelect = document.getElementById('agent-select') as HTMLSelectElement;
const settingsButton = document.getElementById('settings-button') as HTMLButtonElement;

// State
let currentAgentId: string | null = null;
let currentAgent: AgentConfig | null = null;
let isLoading = false;
let connectionRetries = 0;
const MAX_RETRIES = 3;
let messageHistory: ChatMessage[] = [];
let currentSession: StreamingSession | null = null;
const configStorage = ConfigStorage.getInstance();

// Image attachment state
interface ImageAttachment {
  id: string;
  dataUrl: string;
  mimeType: string;
  size: number;
  filename: string;
}

let pendingAttachments: ImageAttachment[] = [];

// Command system
let commandRegistry: CommandRegistry;
let commandProcessor: CommandProcessor;

// Scroll management state
let isUserAtBottom = true; // Initially at bottom

/**
 * Resize image if it exceeds max dimensions
 * Maintains aspect ratio and converts to JPEG for efficiency
 * @param file Original image file
 * @param maxDimension Max width/height (default 1920px)
 * @param quality JPEG quality 0-1 (default 0.85)
 * @returns Resized data URL
 */
async function resizeImageIfNeeded(
  file: File,
  maxDimension = 1920,
  quality = 0.85
): Promise<{ dataUrl: string; sizeKB: number }> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      reject(new Error('Failed to create canvas context'));
      return;
    }

    img.onload = () => {
      let { width, height } = img;

      // Check if resize needed
      const needsResize = width > maxDimension || height > maxDimension;

      if (!needsResize && file.size < 1024 * 1024) {
        // Small enough, return original
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const sizeKB = (dataUrl.length * 0.75) / 1024;
          resolve({ dataUrl, sizeKB });
        };
        reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
        reader.readAsDataURL(file);
        return;
      }

      // Calculate new dimensions (maintain aspect ratio)
      if (width > height) {
        if (width > maxDimension) {
          height = (height * maxDimension) / width;
          width = maxDimension;
        }
      } else {
        if (height > maxDimension) {
          width = (width * maxDimension) / height;
          height = maxDimension;
        }
      }

      // Resize
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);

      // Convert to JPEG with quality control
      const resizedDataUrl = canvas.toDataURL('image/jpeg', quality);
      const sizeKB = (resizedDataUrl.length * 0.75) / 1024;
      resolve({ dataUrl: resizedDataUrl, sizeKB });
    };

    img.onerror = () => reject(new Error('Failed to load image'));

    // Load original
    const reader = new FileReader();
    reader.onload = (e) => {
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/**
 * Attach an image file to pending attachments
 * Automatically resizes large images to 1920px max dimension
 */
async function attachImage(file: File): Promise<void> {
  // Validate file type
  if (!file.type.startsWith('image/')) {
    addMessage('error', `Invalid file type: ${file.type}. Please select an image file.`);
    return;
  }

  try {
    // Resize if needed (1920px max, 85% quality)
    const { dataUrl, sizeKB } = await resizeImageIfNeeded(file);

    pendingAttachments.push({
      id: globalThis.crypto.randomUUID(),
      dataUrl,
      mimeType: 'image/jpeg', // Always JPEG after resize
      size: Math.round(sizeKB * 1024),
      filename: file.name,
    });

    updateAttachmentIndicator();
    log.info('[Sidebar] Attached image:', file.name, `(${sizeKB.toFixed(0)}KB)`);
  } catch (error) {
    log.error('[Sidebar] Failed to attach image:', error);
    addMessage(
      'error',
      `Failed to attach image: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Update attachment indicator display
 */
function updateAttachmentIndicator(): void {
  const indicator = document.getElementById('attachment-indicator');
  if (!indicator) return;

  if (pendingAttachments.length === 0) {
    indicator.style.display = 'none';
  } else {
    indicator.style.display = 'block';
    const count = pendingAttachments.length;
    indicator.textContent = `🖼️ ${count} image${count > 1 ? 's' : ''} attached - Press ESC to clear`;

    // Tooltip shows filenames
    indicator.title = pendingAttachments
      .map((a) => `${a.filename} (${(a.size / 1024).toFixed(1)}KB)`)
      .join('\n');
  }
}

// Parse the attached tab ID from the URL hash
const attachedTabId = (() => {
  const hash = new URL(window.location.href).hash;
  const match = hash.match(/#tab=(\d+)/);
  return match ? Number(match[1]) : null;
})();

log.info('[Sidebar] Initialized for tab:', attachedTabId);

/**
 * Get current page context (URL, title) for the attached tab.
 * Returns null if no tab attached or tab info unavailable.
 */
async function getPageContext(): Promise<{ url: string; title: string } | null> {
  if (!attachedTabId) return null;
  try {
    const tab = await chrome.tabs.get(attachedTabId);
    return { url: tab.url || '', title: tab.title || '' };
  } catch {
    return null;
  }
}

/**
 * Build XML context string to prepend to user messages.
 * Provides page awareness to the model without tool calls.
 */
function buildPageContextXml(ctx: { url: string; title: string }): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<page_context>
<url>${esc(ctx.url)}</url>
<title>${esc(ctx.title)}</title>
</page_context>

`;
}

// Smart scroll management helpers
function checkIfUserAtBottom(): boolean {
  const threshold = 10; // Allow some margin for rounding errors
  return (
    messagesContainer.scrollTop + messagesContainer.clientHeight >=
    messagesContainer.scrollHeight - threshold
  );
}

function maintainScrollPosition(): void {
  // Update our tracking of whether user is at bottom
  isUserAtBottom = checkIfUserAtBottom();
}

function scrollToBottomIfNeeded(): void {
  // Only scroll to bottom if user was already at bottom
  if (isUserAtBottom) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfiguration();
  setupEventListeners();
  setupMessageListener();

  // Initialize command system
  commandRegistry = new CommandRegistry();
  const builtinCommands = createBuiltinCommands(commandRegistry, attachedTabId);
  commandRegistry.registerBuiltins(builtinCommands);
  await commandRegistry.loadUserCommands();
  commandProcessor = new CommandProcessor(commandRegistry);

  // Set up scroll tracking
  messagesContainer.addEventListener('scroll', () => {
    maintainScrollPosition();
  });

  // Listen for clear conversation event from built-in command
  window.addEventListener('clear-conversation', () => {
    clearConversation();
  });

  // Load agents and set up initial state
  await loadAgents();

  // Add initial assistant message
  const welcomeMsg: ChatMessage = {
    id: globalThis.crypto.randomUUID(),
    role: 'assistant',
    content: "Hello! I'm your AI assistant. How can I help you today?",
    timestamp: Date.now(),
    metadata: { agentId: currentAgentId || undefined },
  };
  messageHistory.push(welcomeMsg);
  displayMessage(welcomeMsg);

  // Start health check
  startHealthCheck();

  // Initialize button state
  updateSendButton();
});

async function loadConfiguration() {
  // This function is kept for compatibility but agents are loaded separately
  await loadAgents();
}

async function loadAgents() {
  try {
    const agents = await configStorage.getAgents();
    const defaultAgent = await configStorage.getDefaultAgent();

    // Clear and populate agent selector
    agentSelect.innerHTML = '';

    if (agents.length === 0) {
      agentSelect.innerHTML = '<option value="">No agents configured - Go to Settings</option>';
      agentSelect.disabled = true;
      messageInput.disabled = true;
      messageInput.placeholder = 'Configure an agent in settings to start chatting...';
      sendButton.disabled = true;
      return;
    }

    // Enable UI
    agentSelect.disabled = false;
    messageInput.disabled = false;
    messageInput.placeholder = 'Ask anything. Use /help for available commands.';
    updateSendButton();

    // Populate agents
    agents.forEach((agent) => {
      const option = document.createElement('option');
      option.value = agent.id;
      option.textContent = agent.name;
      agentSelect.appendChild(option);
    });

    // Set current agent (default or first available)
    if (defaultAgent) {
      currentAgentId = defaultAgent.id;
      currentAgent = defaultAgent;
      agentSelect.value = defaultAgent.id;
    } else if (agents.length > 0) {
      currentAgentId = agents[0].id;
      currentAgent = agents[0];
      agentSelect.value = agents[0].id;
    }

    log.info('[Sidebar] Loaded agents:', agents.length, 'Current agent:', currentAgent?.name);
  } catch (error) {
    log.error('[Sidebar] Failed to load agents:', error);
    addMessage('error', 'Failed to load agents. Please check your settings.');
  }
}

// Setup listener for messages from background
function setupMessageListener() {
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    // Filter messages by tabId for tab-specific messages
    if (request.type === 'CONTEXT_SELECTION') {
      // Only handle if the message is for our tab
      if (request.tabId !== attachedTabId) {
        log.debug(
          `[Sidebar] Ignoring CONTEXT_SELECTION for tab ${request.tabId}, our tab is ${attachedTabId}`
        );
        sendResponse({ received: false });
        return false;
      }

      // Handle text selected from context menu
      if (request.text) {
        messageInput.value = `Please help me with this text:\n\n"${request.text}"`;
        messageInput.focus();
      }
    } else if (request.type === 'PING') {
      // PING is tab-agnostic, always respond
      // This is handled by the background script
      sendResponse({ received: true });
    } else {
      // Don't respond to unknown messages - let other handlers deal with them
      log.debug('[Sidebar] Ignoring message type:', request.type);
    }

    return false;
  });
}

// Health check to detect disconnections
function startHealthCheck() {
  setInterval(async () => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'PING',
      } as const);
      if (response?.pong) {
        connectionRetries = 0; // Reset retry counter on success
      }
    } catch {
      connectionRetries++;
      if (connectionRetries >= MAX_RETRIES) {
        log.error('[Sidebar] Lost connection to background service');
        addMessage('error', 'Connection lost. Please reload the extension.');
      }
    }
  }, 30000); // Check every 30 seconds
}

function updateSendButton() {
  if (isLoading) {
    sendButton.innerHTML = '■'; // Solid block for stop
    sendButton.title = 'Stop generation (Esc)';
    sendButton.classList.add('stop-mode');
    sendButton.disabled = false; // Keep enabled for cancellation
  } else {
    sendButton.innerHTML = '➜'; // Heavy round-tipped rightwards arrow
    sendButton.title = 'Send message';
    sendButton.classList.remove('stop-mode');
    sendButton.disabled = messageInput.value.trim() === '';
  }
}

function setupEventListeners() {
  // Send message or cancel on button click
  sendButton.addEventListener('click', () => {
    if (isLoading) {
      cancelCurrentStream();
    } else {
      handleSendMessage();
    }
  });

  // Send message on Enter (without Shift)
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  });

  // Attach button click - open file picker
  const attachButton = document.getElementById('attach-button') as HTMLButtonElement;
  attachButton.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    input.multiple = true; // Allow multi-select
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files) {
        for (const file of Array.from(files)) {
          await attachImage(file);
        }
      }
    };
    input.click();
  });

  // Clipboard paste for images
  messageInput.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    // Check for images in clipboard
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault(); // Don't paste as text

        const file = item.getAsFile();
        if (file) {
          await attachImage(file);
        }
        return;
      }
    }

    // Fall through to default text paste
  });

  // Agent switching
  agentSelect.addEventListener('change', async (e) => {
    const selectedAgentId = (e.target as HTMLSelectElement).value;

    if (!selectedAgentId) {
      currentAgentId = null;
      currentAgent = null;
      return;
    }

    try {
      const agent = await configStorage.getAgent(selectedAgentId);
      if (agent) {
        currentAgentId = selectedAgentId;
        currentAgent = agent;

        addMessage('system', `Switched to ${agent.name} (${agent.provider.toUpperCase()})`);
      }
    } catch (error) {
      addMessage('error', 'Failed to switch agent');
      log.error('[Sidebar] Agent switch error:', error);
    }
  });

  // Auto-resize textarea and update button state
  messageInput.addEventListener('input', () => {
    const currentHeight = messageInput.offsetHeight;

    // If content overflows current height, grow immediately
    if (messageInput.scrollHeight > currentHeight && currentHeight < 140) {
      messageInput.style.height = `${Math.min(messageInput.scrollHeight, 140)}px`;
    }
    // If content is less than current height, shrink by resetting
    else if (messageInput.scrollHeight < currentHeight) {
      messageInput.style.height = '88px'; // Reset to base height
      if (messageInput.scrollHeight > 88) {
        messageInput.style.height = `${Math.min(messageInput.scrollHeight, 140)}px`;
      }
    }

    if (!isLoading) {
      updateSendButton();
    }
  });

  // Settings button click
  settingsButton.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

async function handleSendMessage() {
  const text = messageInput.value.trim();

  // Require either text or attachments
  if (!text && pendingAttachments.length === 0) return;
  if (isLoading) return;

  // Clear input immediately for better UX
  messageInput.value = '';
  messageInput.style.height = '88px';

  // Process slash commands (only if there's text)
  if (text) {
    const processed = await commandProcessor.process(text);

    if (processed) {
      if (processed.type === 'action' && processed.action) {
        // Execute built-in command (doesn't send to LLM)
        try {
          processed.action();
        } catch (error) {
          log.error('[Sidebar] Command execution error:', error);
          addMessage('error', `Command failed: ${error}`);
        }
        return;
      } else if (processed.type === 'text' && processed.content) {
        // Replace message with expanded template and continue with attachments
        const expandedMessage = processed.content;
        await createAndSendMessage(expandedMessage);
        return;
      }
    }
  }

  // Regular message (not a command)
  await createAndSendMessage(text);
}

/**
 * Helper to create message with attachments and send to AI
 */
async function createAndSendMessage(text: string) {
  // Build multi-part content
  const content: MessagePart[] = [];

  if (text) {
    content.push({ type: 'text', text });
  }

  for (const attachment of pendingAttachments) {
    content.push({
      type: 'image',
      image: attachment.dataUrl,
      mimeType: attachment.mimeType,
    });
  }

  // Create message
  const userMsg: ChatMessage = {
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    content:
      content.length === 1 && content[0].type === 'text'
        ? (content[0].text ?? '') // Keep as string if text-only (backward compatible)
        : content, // Use multi-part for images
    timestamp: Date.now(),
    metadata: {
      hasAttachments: pendingAttachments.length > 0,
    },
  };

  messageHistory.push(userMsg);
  addMessage('user', userMsg.content);

  // Clear attachments
  const hadAttachments = pendingAttachments.length > 0;
  pendingAttachments = [];
  updateAttachmentIndicator();

  if (hadAttachments) {
    log.info('[Sidebar] Sending message with attachments to AI');
  }

  await sendToAI();
}

async function sendToAI() {
  // When user sends a message, assume they want to see the response
  isUserAtBottom = true;

  // Set loading state
  isLoading = true;
  updateSendButton();

  try {
    // Check if agent is selected and configured
    if (!currentAgentId || !currentAgent) {
      addMessage('error', 'Please select an agent or configure agents in settings.');
      return;
    }

    // Require API key unless custom endpoint is provided
    if (!currentAgent.apiKey && !currentAgent.endpoint) {
      addMessage(
        'error',
        `Agent "${currentAgent.name}" needs an API key or custom endpoint. Please configure it in settings.`
      );
      return;
    }

    // Start streaming from AI (uses messageHistory)
    await streamAIResponse();
  } catch (error) {
    addMessage('error', 'Failed to send message. Please try again.');
    log.error('[Sidebar] Send message error:', error);
  } finally {
    isLoading = false;
    updateSendButton();
  }
}

async function streamAIResponse() {
  log.debug('[Sidebar] Starting streamAIResponse for agent:', currentAgent?.name);

  if (!currentAgentId || !currentAgent) {
    throw new Error('No agent selected');
  }

  // Create connection for streaming - include tabId for isolation
  const connectionId = `ai-stream-${attachedTabId || 'unknown'}-${Date.now()}`;
  log.debug('[Sidebar] Creating port connection:', connectionId, 'for tab:', attachedTabId);
  const port = chrome.runtime.connect({ name: connectionId });

  // Initialize streaming session
  currentSession = {
    port,
    currentReasoningBox: undefined,
    reasoningBoxes: [],
    currentTextBox: undefined,
    toolCalls: new Map(),
  };

  // Create assistant message placeholder (don't add to history yet)
  const assistantMsg: ChatMessage = {
    id: globalThis.crypto.randomUUID(),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    metadata: { agentId: currentAgentId, agentName: currentAgent.name },
  };

  // Get page context to prepend to user messages (gives model URL/title awareness)
  const pageContext = await getPageContext();
  const contextPrefix = pageContext ? buildPageContextXml(pageContext) : '';

  return new Promise<void>((resolve, reject) => {
    if (!currentSession) {
      reject(new Error('Session not created'));
      return;
    }

    currentSession.port.onMessage.addListener((msg) => {
      log.debug('[Sidebar] Received message from port:', msg.type, msg);
      switch (msg.type) {
        case 'STREAM_REASONING_START': {
          // Check if we should merge with the previous reasoning box
          // (i.e., the last child in the messages container is a reasoning wrapper)
          const lastChild = messagesContainer.lastElementChild;
          const isLastChildReasoningWrapper = lastChild?.classList.contains('reasoning-wrapper');
          const lastReasoningBox =
            currentSession?.reasoningBoxes[currentSession.reasoningBoxes.length - 1];

          // If the last element is a reasoning wrapper that's not actively streaming, reuse its box
          if (
            isLastChildReasoningWrapper &&
            lastReasoningBox &&
            !lastReasoningBox.isStreamingActive()
          ) {
            log.debug('[Sidebar] Merging with previous reasoning box (adjacent segments)');

            // Add simple break between merged segments
            lastReasoningBox.appendChunk('\n\n');
            lastReasoningBox.startStreaming(true); // Restart streaming, preserving content

            if (currentSession) {
              currentSession.currentReasoningBox = lastReasoningBox;
            }
          } else {
            // Create a new reasoning box (not adjacent to another reasoning box)
            const reasoningBox = new ReasoningBox();
            if (currentSession) {
              // End any previous reasoning box that might still be streaming
              if (
                currentSession.currentReasoningBox &&
                currentSession.currentReasoningBox !== reasoningBox
              ) {
                currentSession.currentReasoningBox.finishStreaming();
              }

              // Set as current and add to list
              currentSession.currentReasoningBox = reasoningBox;
              currentSession.reasoningBoxes.push(reasoningBox);
            }

            // Create a wrapper for the reasoning box to maintain consistent spacing
            const reasoningWrapper = document.createElement('div');
            reasoningWrapper.className = 'reasoning-wrapper';
            reasoningWrapper.appendChild(reasoningBox.getElement());

            // Append chronologically - always at the end
            messagesContainer.appendChild(reasoningWrapper);
            reasoningBox.startStreaming();

            log.debug(
              `[Sidebar] Created new reasoning box #${currentSession?.reasoningBoxes.length || 1}`,
              {
                offsetHeight: reasoningBox.getElement().offsetHeight,
              }
            );
          }

          scrollToBottomIfNeeded();
          break;
        }

        case 'STREAM_REASONING_CHUNK': {
          // Append to the current reasoning box
          if (currentSession?.currentReasoningBox) {
            currentSession.currentReasoningBox.appendChunk(msg.chunk || '');
            scrollToBottomIfNeeded();
          } else {
            log.debug('[Sidebar] Received reasoning chunk without active reasoning box');
          }
          break;
        }

        case 'STREAM_REASONING_END': {
          // Finish the current reasoning box
          if (currentSession?.currentReasoningBox) {
            currentSession.currentReasoningBox.finishStreaming(msg.usage);
            log.debug('[Sidebar] Ended reasoning box');
            // Clear the current reference but keep it in the list
            currentSession.currentReasoningBox = undefined;
          }
          break;
        }

        case 'STREAM_TEXT_BLOCK_START': {
          // Clean up any previous text box (defensive)
          if (currentSession?.currentTextBox) {
            currentSession.currentTextBox.finishStreaming();
          }

          const textBox = new TextBox(msg.blockId);
          if (currentSession) {
            currentSession.currentTextBox = textBox;
          }

          // Append chronologically - always at the end
          messagesContainer.appendChild(textBox.getElement());
          textBox.startStreaming();
          scrollToBottomIfNeeded();

          log.debug(`[Sidebar] Created text block ${msg.blockId}`);
          break;
        }

        case 'STREAM_TEXT_BLOCK_CHUNK': {
          log.debug(`[Sidebar] Chunk for block ${msg.blockId}: "${msg.chunk.substring(0, 50)}..."`);

          if (currentSession?.currentTextBox) {
            currentSession.currentTextBox.appendChunk(msg.chunk);
            scrollToBottomIfNeeded();
          } else {
            log.error(`[Sidebar] ERROR: No text box available for block ${msg.blockId}!`);
          }

          break;
        }

        case 'STREAM_TEXT_BLOCK_END': {
          // Finish the current text box
          if (currentSession?.currentTextBox) {
            currentSession.currentTextBox.finishStreaming();
            currentSession.currentTextBox = undefined; // Clear reference
            log.debug(`[Sidebar] Ended text block ${msg.blockId}`);
          } else {
            log.debug(`[Sidebar] No active text box to end for block ${msg.blockId}`);
          }
          break;
        }

        case 'STREAM_TOOL_CALL':
          // Add tool call box as a separate element in the chat flow
          if (msg.toolCall && currentSession) {
            const toolBox = new ToolCallBox(msg.toolCall);
            currentSession.toolCalls.set(msg.toolCall.id, toolBox);

            // Add tool call to assistant message for history tracking
            if (!assistantMsg.toolCalls) {
              assistantMsg.toolCalls = [];
            }
            assistantMsg.toolCalls.push(msg.toolCall);

            // Create a wrapper for the tool call to maintain consistent spacing
            const toolCallWrapper = document.createElement('div');
            toolCallWrapper.className = 'tool-call-wrapper';
            toolCallWrapper.appendChild(toolBox.getElement());

            // Append chronologically - always at the end
            messagesContainer.appendChild(toolCallWrapper);

            // Smart scroll - only scroll if user is at bottom
            scrollToBottomIfNeeded();
          }
          break;

        case 'STREAM_TOOL_RESULT':
          // Update existing tool call box
          if (msg.toolCallId && currentSession?.toolCalls.has(msg.toolCallId)) {
            const toolBox = currentSession.toolCalls.get(msg.toolCallId);
            toolBox?.updateResult(msg.output, msg.status || 'success', msg.error);

            // Update in message history
            const toolCall = assistantMsg.toolCalls?.find(
              (tc: ToolCall) => tc.id === msg.toolCallId
            );
            if (toolCall) {
              toolCall.output = msg.output;
              toolCall.status = msg.status || 'success';
              toolCall.error = msg.error;
              toolCall.endTime = Date.now();
              if (toolCall.startTime) {
                toolCall.duration = toolCall.endTime - toolCall.startTime;
              }
            }

            // Auto-scroll
            scrollToBottomIfNeeded();
          }
          break;

        case 'STREAM_COMPLETE': {
          // Streaming complete, update message history and UI
          assistantMsg.content = msg.fullResponse || '';
          messageHistory.push(assistantMsg);

          // Session cleanup (TextBox handles its own cleanup)
          if (currentSession) {
            currentSession.port.disconnect();
            currentSession = null;
          }

          isLoading = false;
          updateSendButton();
          resolve();
          break;
        }

        case 'STREAM_ERROR': {
          // Handle streaming error
          log.error('[Sidebar] Stream error:', msg.error);

          // Clean up session components
          if (currentSession) {
            // Clean up any active text box
            if (currentSession.currentTextBox) {
              currentSession.currentTextBox.destroy();
            }
            // Clean up reasoning box if streaming
            if (currentSession.currentReasoningBox?.isStreamingActive()) {
              currentSession.currentReasoningBox.finishStreaming();
            }
            currentSession.port.disconnect();
            currentSession = null;
          }

          // Enhanced error messages for multi-modal issues
          let errorMessage = msg.error || 'Streaming failed';

          // Check for common multi-modal errors
          if (
            errorMessage.toLowerCase().includes('image') ||
            errorMessage.toLowerCase().includes('vision')
          ) {
            errorMessage +=
              '\n\nNote: Make sure your agent supports vision (GPT-4V, Claude 3+, Gemini).';
          }
          if (
            errorMessage.toLowerCase().includes('size') ||
            errorMessage.toLowerCase().includes('too large')
          ) {
            errorMessage += '\n\nTry sending fewer or smaller images.';
          }
          if (errorMessage.toLowerCase().includes('format')) {
            errorMessage += '\n\nSupported formats: PNG, JPEG, GIF, WebP.';
          }

          addMessage('error', errorMessage);
          // Don't pop from history since we didn't add it yet
          isLoading = false;
          updateSendButton();
          reject(new Error(msg.error));
          break;
        }
      }
    });

    currentSession.port.onDisconnect.addListener(() => {
      // Handle unexpected disconnection
      if (currentSession) {
        // Clean up any active text box
        if (currentSession.currentTextBox) {
          currentSession.currentTextBox.finishStreaming();
        }
        currentSession = null;
      }
    });

    // Send messages to stream (exclude empty messages)
    // Prepend page context to user messages so model knows current page
    const messagesToSend = messageHistory
      .filter((m) => {
        if (m.role !== 'user' && m.role !== 'assistant') return false;

        // Handle string content
        if (typeof m.content === 'string') {
          return m.content.trim() !== '';
        }

        // Handle multi-part content (images count as non-empty)
        return m.content.length > 0;
      })
      .map((m) => {
        // Prepend context to user messages only
        if (m.role === 'user' && contextPrefix) {
          if (typeof m.content === 'string') {
            return { role: m.role, content: contextPrefix + m.content };
          }
          // Multi-part: prepend to first text part or add new text part
          const parts = [...m.content];
          const firstTextIdx = parts.findIndex((p) => p.type === 'text');
          if (firstTextIdx >= 0 && parts[firstTextIdx].text) {
            parts[firstTextIdx] = {
              ...parts[firstTextIdx],
              text: contextPrefix + parts[firstTextIdx].text,
            };
          } else {
            parts.unshift({ type: 'text', text: contextPrefix });
          }
          return { role: m.role, content: parts };
        }
        return { role: m.role, content: m.content };
      });

    log.debug('[Sidebar] Sending messages to stream:', {
      agentId: currentAgentId,
      agentName: currentAgent?.name,
      messageCount: messagesToSend.length,
      messages: messagesToSend,
    });

    if (!currentSession) {
      reject(new Error('Session not available'));
      return;
    }

    currentSession.port.postMessage({
      type: 'STREAM_CHAT',
      agentId: currentAgentId,
      tabId: attachedTabId || undefined, // Pass the attached tab ID for tool scoping
      messages: messagesToSend,
    });
  });
}

function addMessage(
  role: 'user' | 'assistant' | 'system' | 'error',
  content: MessageContent,
  isStreaming = false
): HTMLDivElement {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message message-${role}`;
  if (isStreaming) {
    messageDiv.classList.add('streaming');
  }

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';

  // Handle string content (backward compatible)
  if (typeof content === 'string') {
    // Support markdown formatting
    if (role === 'assistant' && content) {
      StreamingMarkdownRenderer.renderComplete(contentDiv, content);
    } else if (role === 'assistant' && isStreaming) {
      // Empty content for streaming, will be filled incrementally
      contentDiv.innerHTML = '';
    } else {
      contentDiv.textContent = content;
    }
  } else {
    // Handle multi-part content
    const textParts = content.filter((p) => p.type === 'text');
    const imageParts = content.filter((p) => p.type === 'image');

    // Render text parts
    if (textParts.length > 0) {
      const textContent = textParts.map((p) => p.text).join('\n');
      if (role === 'assistant') {
        StreamingMarkdownRenderer.renderComplete(contentDiv, textContent);
      } else {
        contentDiv.textContent = textContent;
      }
    }

    // Add attachment badge for images
    if (imageParts.length > 0) {
      const badge = document.createElement('span');
      badge.className = 'attachment-badge';
      badge.textContent = `📎 ${imageParts.length} image${imageParts.length > 1 ? 's' : ''}`;
      contentDiv.appendChild(badge);
    }
  }

  messageDiv.appendChild(contentDiv);
  messagesContainer.appendChild(messageDiv);

  // Smart scroll - only scroll if user is at bottom
  scrollToBottomIfNeeded();

  return messageDiv;
}

// Add clear conversation functionality
function clearConversation() {
  messageHistory = [];
  messagesContainer.innerHTML = '';
  // Clean up any active session
  if (currentSession) {
    currentSession.port.disconnect();
    currentSession = null;
  }

  // Reset scroll state - we're back at the top/beginning
  isUserAtBottom = true;

  // Add welcome message again
  const welcomeMsg: ChatMessage = {
    id: globalThis.crypto.randomUUID(),
    role: 'assistant',
    content: 'Conversation cleared. How can I help you?',
    timestamp: Date.now(),
    metadata: { agentId: currentAgentId || undefined, agentName: currentAgent?.name },
  };
  messageHistory.push(welcomeMsg);
  displayMessage(welcomeMsg);
}

// Helper function to display a message with its tool calls in chronological order
function displayMessage(msg: ChatMessage): void {
  // Display tool calls first (if any) - they happened before the response
  if (msg.toolCalls && msg.toolCalls.length > 0 && msg.role === 'assistant') {
    msg.toolCalls.forEach((toolCall) => {
      const toolBox = new ToolCallBox(toolCall);
      const toolCallWrapper = document.createElement('div');
      toolCallWrapper.className = 'tool-call-wrapper';
      toolCallWrapper.appendChild(toolBox.getElement());
      messagesContainer.appendChild(toolCallWrapper);
    });
  }

  // Then display the message content
  if (msg.content) {
    addMessage(msg.role as 'user' | 'assistant' | 'system' | 'error', msg.content);
  }
}

// Add keyboard shortcut for clearing (Cmd/Ctrl+K)
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    clearConversation();
  }
});

// Cancel current stream
function cancelCurrentStream() {
  if (currentSession) {
    chrome.runtime.sendMessage({
      type: 'CANCEL_STREAM',
      connectionId: currentSession.port.name,
    } as const);

    // Clean up session components
    if (currentSession.currentTextBox) {
      currentSession.currentTextBox.destroy();
    }
    if (currentSession.currentReasoningBox?.isStreamingActive()) {
      currentSession.currentReasoningBox.finishStreaming();
    }

    currentSession.port.disconnect();
    currentSession = null;
    isLoading = false;
    updateSendButton();
  }
}

// Cancel current stream on Escape OR clear attachments
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Priority 1: Cancel active stream
    if (currentSession) {
      cancelCurrentStream();
    }
    // Priority 2: Clear pending attachments
    else if (pendingAttachments.length > 0) {
      pendingAttachments = [];
      updateAttachmentIndicator();
      log.info('[Sidebar] Cleared pending attachments');
    }
  }
});

export {};
