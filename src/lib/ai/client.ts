/**
 * AI Client - Service Worker LLM integration using Vercel AI SDK
 *
 * Architecture: Direct API calls from service worker using host_permissions to bypass CORS.
 * Streaming responses are sent back to sidebar via Chrome runtime messaging.
 */

import { streamText, CoreMessage } from 'ai';
import type { AgentConfig } from '../storage/config';
import type { ToolCall } from '../../types';
import {
  ConfigStorage,
  ConfigValidationError,
  configValidationMessage,
  resolveSystemPrompt,
} from '../storage/config';
import { getToolRegistry } from '../webmcp/tool-registry';
import { getRemoteMCPManager } from '../mcp/manager';
import { createModelRuntime } from './model-runtime';
import { isOpenAIProtocol, providerForApiProtocol, type ApiProtocol } from './protocol';

interface APIError extends Error {
  statusCode?: number;
  status?: number;
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as APIError;
  return typeof candidate.statusCode === 'number'
    ? candidate.statusCode
    : typeof candidate.status === 'number'
      ? candidate.status
      : undefined;
}

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'name' in error && error.name === 'AbortError';
}

function raceWithAbort<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

async function* abortableAsyncIterable<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      const next = await raceWithAbort(iterator.next(), signal);
      if (next.done) {
        completed = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!completed && iterator.return) {
      try {
        void Promise.resolve(iterator.return()).catch(() => undefined);
      } catch {
        // A non-cooperative provider must not delay cancellation cleanup.
      }
    }
  }
}

/** Provider errors may contain prompts, generated text, headers, or proxy internals. */
function publicAIRequestError(error: unknown): Error {
  const status = getErrorStatus(error);
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (
    status === 401 ||
    status === 403 ||
    message.includes('401') ||
    message.includes('403') ||
    message.includes('unauthorized')
  ) {
    return new Error('Authentication failed. Check the configured credentials.');
  }
  if (status === 404 || message.includes('404') || message.includes('not found')) {
    return new Error('The configured model or endpoint was not found.');
  }
  if (status === 408 || message.includes('408') || message.includes('timeout')) {
    return new Error('The AI request timed out. Try again.');
  }
  if (status === 429 || message.includes('429') || message.includes('rate limit')) {
    return new Error('The AI service rate limit was reached. Try again later.');
  }
  if (status !== undefined && status >= 500) {
    return new Error('The AI service is temporarily unavailable. Try again later.');
  }
  if (error instanceof TypeError) {
    return new Error('Could not connect to the configured AI endpoint.');
  }
  return new Error(
    'AI request failed. Verify the Connection API, endpoint, model, and credentials.'
  );
}

export interface StreamFinishMetadata {
  /** True when the stream ended because the tab's tool set changed mid-stream.
   *  The caller should restart the conversation with fresh tools. */
  toolsChanged: boolean;
  /** True when the stream ended because the agent's maxSteps limit was reached.
   *  The caller should give the model one more text-only turn to summarize. */
  stepsExhausted: boolean;
}

export interface StreamCallbacks {
  // Text block callbacks - each text-start/end creates a separate message
  onTextBlockStart?: (blockId: string) => void;
  onTextBlockChunk?: (blockId: string, chunk: string) => void;
  onTextBlockEnd?: (blockId: string) => void;

  onFinish: (fullText: string, metadata?: StreamFinishMetadata) => void;
  onError: (error: Error) => void;
  onAbort?: () => void;

  // Tool callbacks
  onToolCall?: (toolCall: ToolCall) => void;
  onToolResult?: (result: {
    id: string;
    output: unknown;
    status: 'success' | 'error';
    error?: string;
  }) => void;

  // Reasoning callbacks for transparent thinking display
  onReasoningStart?: () => void;
  onReasoningChunk?: (chunk: string) => void;
  onReasoningEnd?: (usage?: { reasoningTokens: number }) => void;
}

export class AIClient {
  private static instance: AIClient;
  private configStorage: ConfigStorage;
  private activeStream?: {
    id: string;
    controller: AbortController;
    notifyAbort: () => void;
  };
  private streamRequestSequence = 0;
  private latestAcceptedStreamSequence = 0;
  private pendingStreams = new Map<
    string,
    { controller: AbortController; notifyAbort: () => void; sequence: number }
  >();

  static getInstance(): AIClient {
    if (!AIClient.instance) {
      AIClient.instance = new AIClient();
    }
    return AIClient.instance;
  }

  private constructor() {
    this.configStorage = ConfigStorage.getInstance();
  }

  /**
   * Check if an agent is configured and ready
   */
  async isAgentAvailable(agentId: string): Promise<boolean> {
    const agent = await this.configStorage.getAgent(agentId);
    // Agent is available if it has an API key OR a custom endpoint
    return agent !== null && (!!agent.apiKey || !!agent.endpoint);
  }

  /**
   * List all configured agents
   */
  async getAvailableAgents(): Promise<AgentConfig[]> {
    return await this.configStorage.getAgents();
  }

  /**
   * Stream a chat completion from the specified agent
   * @param tabId - Optional tab ID to scope tools to a specific tab
   * @param streamId - Ownership token required to cancel this specific stream
   */
  async streamChat(
    agentId: string,
    messages: CoreMessage[],
    tabId: number | undefined,
    callbacks: StreamCallbacks,
    streamId: string = globalThis.crypto.randomUUID()
  ): Promise<void> {
    const requestSequence = ++this.streamRequestSequence;
    let abortController: AbortController | undefined;
    let abortNotified = false;
    const notifyAbort = () => {
      if (abortNotified) return;
      abortNotified = true;
      try {
        callbacks.onAbort?.();
      } catch {
        // Cancellation ownership must not depend on a stale caller callback succeeding.
      }
    };
    const pendingStream = {
      controller: new AbortController(),
      notifyAbort,
      sequence: requestSequence,
    };
    this.pendingStreams.set(streamId, pendingStream);

    try {
      const agent = await raceWithAbort(
        this.configStorage.getAgent(agentId),
        pendingStream.controller.signal
      );
      if (requestSequence < this.latestAcceptedStreamSequence) {
        notifyAbort();
        return;
      }
      if (!agent) {
        throw new Error('Agent configuration was not found. Reload settings and try again.');
      }
      if (!agent.apiKey && !agent.endpoint) {
        throw new Error('Configure credentials or a custom endpoint in Settings.');
      }

      // Only a validated newer request may supersede the active provider stream.
      // The sequence check prevents slower setup from reclaiming ownership later.
      this.latestAcceptedStreamSequence = requestSequence;
      this.pendingStreams.delete(streamId);
      for (const [pendingId, olderPendingStream] of this.pendingStreams) {
        if (olderPendingStream.sequence >= requestSequence) continue;
        this.pendingStreams.delete(pendingId);
        olderPendingStream.controller.abort();
        olderPendingStream.notifyAbort();
      }
      const supersededStream = this.activeStream;
      supersededStream?.controller.abort();
      supersededStream?.notifyAbort();
      abortController = new AbortController();
      this.activeStream = { id: streamId, controller: abortController, notifyAbort };

      const runtime = createModelRuntime(agent);

      // Build system prompt: base + user custom + MCP server instructions (if any)
      const mcpInstructions = getRemoteMCPManager().getMCPInstructions();
      const systemParts = [resolveSystemPrompt(agent), mcpInstructions].filter(Boolean);
      const systemPrompt = systemParts.join('\n\n');

      const messagesWithSystem: CoreMessage[] = systemPrompt
        ? [{ role: 'system', content: systemPrompt }, ...messages]
        : messages;

      // Subscribe to tab-scoped tool changes for the duration of this stream.
      // When tools change (navigation, user toggle, etc.), we stop after the
      // current step so the caller can restart with a correct tool set.
      let toolsInvalidated = false;
      let stepsExhausted = false;
      let unsubToolChange: (() => void) | null = null;

      if (tabId) {
        const toolRegistry = getToolRegistry();
        unsubToolChange = toolRegistry.onTabToolsChanged(tabId, () => {
          toolsInvalidated = true;
        });
      }

      try {
        // Get tools from unified registry (already loaded by background)
        const toolRegistry = getToolRegistry();

        // Get tools scoped to the specific tab if tabId is provided.
        // This ensures each sidebar only sees tools from its associated tab.
        // Tab-bound system tools (e.g., navigate) are injected by the registry.
        const allTools = tabId ? toolRegistry.getToolsForTab(tabId) : toolRegistry.getAllTools();

        const hasTools = Object.keys(allTools).length > 0;

        const streamParams: Parameters<typeof streamText>[0] = {
          model: runtime.model,
          messages: messagesWithSystem,
          // Don't pass temperature when reasoning is enabled (SDK warning suggests this)
          ...(agent.reasoning?.enabled ? {} : { temperature: agent.temperature }),
          maxRetries: 2,
          abortSignal: abortController.signal,
          ...(hasTools && {
            tools: allTools,
            // Stop after current step if tools changed (navigation, etc.)
            // or after agent-configured step limit (default 10).
            stopWhen: ({ steps }) => {
              if (toolsInvalidated) return true;
              if (steps.length >= (agent.maxSteps ?? 10)) {
                stepsExhausted = true;
                return true;
              }
              return false;
            },
          }),
          ...(runtime.providerOptions && {
            providerOptions: runtime.providerOptions,
          }),
        };

        const streamResult = streamText(streamParams as Parameters<typeof streamText>[0]);

        // Handle the stream with tool support
        const { textStream, fullStream } = await streamResult;

        let _fullText = '';
        let textBlockCount = 0;
        let currentTextBlockId: string | null = null; // Track the active text block
        let isReasoning = false; // Track if we're currently in reasoning phase
        let currentReasoningId: string | undefined; // Track the current reasoning segment ID
        let reasoningTokens: number | undefined; // Track reasoning token usage

        // Use fullStream for tools OR reasoning support
        if (hasTools || agent.reasoning?.enabled) {
          for await (const part of abortableAsyncIterable(fullStream, abortController.signal)) {
            // Handle reasoning events from various providers.
            const eventType = (part as Record<string, unknown>).type;

            // Handle OpenAI reasoning-start event (marks beginning but no content)
            if (eventType === 'reasoning-start') {
              // OpenAI uses reasoning-start to mark beginning, but content comes in reasoning-delta
              continue;
            }

            // Handle OpenAI reasoning-end event (marks end of a segment)
            if (eventType === 'reasoning-end') {
              if (isReasoning) {
                callbacks.onReasoningEnd?.();
                isReasoning = false;
                currentReasoningId = undefined;
              }
              continue;
            }

            // For OpenAI, check if this is a reasoning-delta with a new segment ID
            if (eventType === 'reasoning-delta' || eventType === 'reasoning') {
              const partData = part as Record<string, unknown>;
              const reasoningId = partData.id as string | undefined;

              // Extract segment ID from format like "rs_xxx:3" -> "3"
              const segmentId = reasoningId?.split(':').pop();

              // Check if this is a new reasoning segment
              if (segmentId && segmentId !== currentReasoningId) {
                // End previous reasoning segment if one was active
                if (isReasoning && currentReasoningId) {
                  callbacks.onReasoningEnd?.();
                  isReasoning = false;
                }

                // Start new reasoning segment
                currentReasoningId = segmentId;
                isReasoning = true;
                callbacks.onReasoningStart?.();
              }

              const reasoningText =
                (partData.text as string) ||
                (partData.textDelta as string) ||
                (partData.delta as string) ||
                '';

              if (reasoningText) {
                callbacks.onReasoningChunk?.(reasoningText);
              }
              continue;
            }

            // Check for other reasoning event types (Claude, Gemini)
            if (
              eventType === 'thinking' ||
              eventType === 'thinking-delta' ||
              eventType === 'thought' ||
              eventType === 'thought-delta'
            ) {
              const reasoningText =
                ((part as Record<string, unknown>).text as string) ||
                ((part as Record<string, unknown>).textDelta as string) ||
                ((part as Record<string, unknown>).delta as string) ||
                '';

              if (!isReasoning) {
                isReasoning = true;
                callbacks.onReasoningStart?.();
              }

              if (reasoningText) {
                callbacks.onReasoningChunk?.(reasoningText);
              }
              continue;
            }

            // Also check if the part has providerMetadata that might contain reasoning
            const metadata = (part as Record<string, unknown>).providerMetadata as
              | {
                  anthropic?: { thinking?: unknown };
                  google?: { thinking?: unknown };
                }
              | undefined;
            if (metadata?.anthropic?.thinking || metadata?.google?.thinking) {
              if (!isReasoning) {
                isReasoning = true;
                callbacks.onReasoningStart?.();
              }
            }

            // Handle text blocks as separate messages
            if (part.type === 'text-start') {
              // For non-OpenAI providers, end reasoning if it's still active
              // OpenAI sends explicit reasoning-end events, so we don't need this
              if (isReasoning && !isOpenAIProtocol(runtime.apiProtocol)) {
                callbacks.onReasoningEnd?.(reasoningTokens ? { reasoningTokens } : undefined);
                isReasoning = false;
                currentReasoningId = undefined;
              }

              textBlockCount++;
              // Always use our own incrementing ID since SDK reuses "0" across steps
              currentTextBlockId = `block-${textBlockCount}`;

              // Always treat text blocks as regular response blocks
              callbacks.onTextBlockStart?.(currentTextBlockId);
            } else if (part.type === 'text-end') {
              // Use the current block ID that was set at text-start
              if (currentTextBlockId) {
                // Emit text block end event
                callbacks.onTextBlockEnd?.(currentTextBlockId);

                // Clear the current block ID
                currentTextBlockId = null;
              }
            } else if (part.type === 'text-delta') {
              // If reasoning was active and now text is coming, end reasoning
              if (isReasoning) {
                callbacks.onReasoningEnd?.(reasoningTokens ? { reasoningTokens } : undefined);
                isReasoning = false;
              }

              const chunk = part.text || '';

              // Use the current block ID that was set at text-start
              if (!currentTextBlockId) {
                textBlockCount++;
                currentTextBlockId = `block-${textBlockCount}`;
                callbacks.onTextBlockStart?.(currentTextBlockId);
              }

              // Emit text block chunk event for interleaved display
              callbacks.onTextBlockChunk?.(currentTextBlockId, chunk);

              _fullText += chunk;
            } else if (part.type === 'tool-call') {
              // Create structured tool call object
              const toolCall: ToolCall = {
                id: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
                status: 'running',
                startTime: Date.now(),
              };

              // Emit structured tool call event if callback exists
              if (callbacks.onToolCall) {
                callbacks.onToolCall(toolCall);
              }
            } else if (part.type === 'tool-result') {
              // Emit structured tool result event if callback exists
              if (callbacks.onToolResult) {
                callbacks.onToolResult({
                  id: part.toolCallId,
                  output: part.output,
                  status: 'success',
                });
              }
              // The AI should continue generating text after tool results
            } else if (part.type === 'tool-error') {
              callbacks.onToolResult?.({
                id: part.toolCallId,
                output: null,
                status: 'error',
                error: 'Tool execution failed',
              });
            } else if (part.type === 'finish') {
              // Handle finish event with usage data
              // The finish event has totalUsage property according to SDK types
              const usage = part.totalUsage || (part as Record<string, unknown>).usage || {};
              reasoningTokens = (usage as Record<string, unknown>)?.reasoningTokens as
                | number
                | undefined;

              // If reasoning is still active at finish (no text phase), end it now
              if (isReasoning) {
                callbacks.onReasoningEnd?.({ reasoningTokens: reasoningTokens || 0 });
                isReasoning = false;
              }
            }
          }
        } else {
          // No tools, use simple text stream
          for await (const chunk of abortableAsyncIterable(textStream, abortController.signal)) {
            _fullText += chunk;
            // Legacy mode - no structured events, just raw text
          }
        }

        callbacks.onFinish(_fullText, { toolsChanged: toolsInvalidated, stepsExhausted });
      } finally {
        // Always clean up the tool-change subscription to prevent leaks
        unsubToolChange?.();
      }

      // Note: onFinish above handles the completion
    } catch (error) {
      if (
        requestSequence < this.latestAcceptedStreamSequence ||
        pendingStream.controller.signal.aborted ||
        abortController?.signal.aborted ||
        isAbortError(error)
      ) {
        notifyAbort();
        return;
      }
      callbacks.onError(publicAIRequestError(error));
    } finally {
      if (this.pendingStreams.get(streamId) === pendingStream) {
        this.pendingStreams.delete(streamId);
      }
      if (abortController && this.activeStream?.controller === abortController) {
        this.activeStream = undefined;
      }
    }
  }

  /**
   * Cancel the current streaming operation
   */
  cancelStream(streamId: string): boolean {
    const pendingStream = this.pendingStreams.get(streamId);
    if (pendingStream) {
      this.pendingStreams.delete(streamId);
      pendingStream.controller.abort();
      pendingStream.notifyAbort();
      return true;
    }

    const stream = this.activeStream;
    if (stream?.id !== streamId) return false;
    stream.controller.abort();
    stream.notifyAbort();
    if (this.activeStream === stream) this.activeStream = undefined;
    return true;
  }

  /**
   * Test connection with provided agent details (for new agents before saving)
   */
  async testConnectionWithDetails(details: {
    apiProtocol: ApiProtocol;
    apiKey?: string;
    model: string;
    endpoint?: string;
  }): Promise<{ success: boolean; message: string }> {
    const provider = providerForApiProtocol(details.apiProtocol);

    try {
      // Unsaved probes use the same explicit current contract as saved agents.
      const tempAgent: AgentConfig = {
        id: 'temp-test',
        name: 'Test Agent',
        provider,
        apiProtocol: details.apiProtocol,
        apiKey: details.apiKey,
        model: details.model,
        endpoint: details.endpoint,
        systemPrompt: '',
        temperature: 0.7,
        maxTokens: 1000,
      };

      const runtime = createModelRuntime(tempAgent);

      const testMessages: CoreMessage[] = [
        { role: 'user', content: 'Say "Connection successful" in 3 words or less.' },
      ];

      // A connection probe intentionally stops after the first text chunk. Own the request
      // with a fresh controller so every exit path also stops any remaining generation/billing.
      const testAbortController = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      try {
        const result = await streamText({
          model: runtime.model,
          messages: testMessages,
          temperature: 0.7,
          maxRetries: 0,
          abortSignal: testAbortController.signal,
          ...(runtime.providerOptions && { providerOptions: runtime.providerOptions }),
        });

        const timeoutPromise = new Promise<boolean>((_, reject) => {
          timeoutId = setTimeout(() => {
            // Settle the race with the useful timeout error before aborting the losing stream.
            reject(new Error('Test timeout after 10 seconds'));
            testAbortController.abort();
          }, 10000);
        });

        const streamPromise = (async () => {
          // Reading one chunk directly avoids AsyncIterator.return(), which cancels some
          // provider streams with an undefined reason before our owned abort can run.
          const reader = result.textStream.getReader();
          try {
            const { done, value } = await reader.read();
            return !done && value.length > 0;
          } finally {
            reader.releaseLock();
          }
        })();

        const receivedData = await Promise.race([streamPromise, timeoutPromise]);

        if (!receivedData) {
          return {
            success: false,
            message: 'Endpoint returned no text. Verify it implements the selected Connection API.',
          };
        }

        return {
          success: true,
          message: 'Connection successful.',
        };
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        testAbortController.abort();
      }
    } catch (error) {
      if (isAbortError(error)) {
        return {
          success: false,
          message: 'Connection test was cancelled. Try again.',
        };
      }

      return {
        success: false,
        message: publicAIRequestError(error).message,
      };
    }
  }

  /**
   * Test connection for a specific agent
   */
  async testConnection(agentId: string): Promise<{ success: boolean; message: string }> {
    try {
      const agent = await this.configStorage.getAgent(agentId);
      if (!agent) {
        return {
          success: false,
          message: 'Agent not found. Reload settings and try again.',
        };
      }

      // Saved probes share the same zero-retry, owned-abort path as unsaved probes.
      return this.testConnectionWithDetails({
        apiProtocol: agent.apiProtocol,
        apiKey: agent.apiKey,
        model: agent.model,
        endpoint: agent.endpoint,
      });
    } catch (error) {
      return {
        success: false,
        message:
          error instanceof ConfigValidationError
            ? configValidationMessage(error)
            : 'Connection test failed. Verify the Connection API, endpoint, model, and credentials.',
      };
    }
  }
}
