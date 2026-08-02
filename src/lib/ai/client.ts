/**
 * AI Client - Service Worker LLM integration using Vercel AI SDK
 *
 * Architecture: Direct API calls from service worker using host_permissions to bypass CORS.
 * Streaming responses are sent back to sidebar via Chrome runtime messaging.
 */

import { streamText, CoreMessage } from 'ai';
import { raceWithAbort } from '../abort';
import type { AgentConfig } from '../storage/config';
import type { ConversationWorkspaceContext, ToolCall } from '../../types';
import { ConfigStorage, ConfigValidationError, configValidationMessage } from '../storage/config';
import { MAX_AUTOLOADED_MEMORY_BYTES } from '../memory/filesystem';
import { MAX_WORKSPACE_BOOTSTRAP_BYTES } from '../workspace/context';
import { getMemoryManager, MemoryMountError, type ResolvedMemory } from '../memory/manager';
import { createMemoryTools } from '../memory/tools';
import { composeSystemPrompt, formatMemoryContext } from './system-prompt';
import { getToolRegistry } from '../webmcp/tool-registry';
import { createModelRuntime } from './model-runtime';
import { isOpenAIProtocol, providerForApiProtocol, type ApiProtocol } from './protocol';
import { decideStreamStop } from './stream-policy';

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
  if (error instanceof MemoryMountError) return error;
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

function validateWorkspaceContext(
  context: ConversationWorkspaceContext | undefined,
  expectedAgentId: string
): void {
  if (context === undefined) return;
  if (
    typeof context !== 'object' ||
    context === null ||
    context.agentId !== expectedAgentId ||
    (context.state !== 'mounted' && context.state !== 'unmounted')
  ) {
    throw new Error('Invalid conversation workspace context');
  }
  if (context.state === 'unmounted') return;

  const standing = [context.identity, context.soul, context.user, context.agents];
  if (
    standing.some((value) => value !== null && typeof value !== 'string') ||
    typeof context.memory !== 'string'
  ) {
    throw new Error('Invalid conversation workspace context');
  }

  const encoder = new TextEncoder();
  const memoryBytes = encoder.encode(context.memory).byteLength;
  const totalBytes = standing.reduce(
    (total, value) => total + (value === null ? 0 : encoder.encode(value).byteLength),
    memoryBytes
  );
  if (memoryBytes > MAX_AUTOLOADED_MEMORY_BYTES || totalBytes > MAX_WORKSPACE_BOOTSTRAP_BYTES) {
    throw new Error('Invalid conversation workspace context');
  }
}

function captureWorkspaceContext(
  agentId: string,
  memory: Exclude<ResolvedMemory, { state: 'unavailable' }>
): ConversationWorkspaceContext {
  if (memory.state === 'unmounted') return { agentId, state: 'unmounted' };
  if (!memory.workspace) throw new Error('Workspace bootstrap was not initialized');
  return { agentId, state: 'mounted', ...memory.workspace };
}

function attachMemoryContext(messages: CoreMessage[], snapshot: string): CoreMessage[] {
  const userIndex = messages.findIndex(({ role }) => role === 'user');
  if (userIndex === -1) {
    throw new Error('Mounted memory requires a user message');
  }

  const next = [...messages];
  const memoryContext = formatMemoryContext(snapshot);
  const userMessage = next[userIndex];
  const content = userMessage.content;
  const contextualContent =
    typeof content === 'string'
      ? `${memoryContext}\n\n${content}`
      : [{ type: 'text' as const, text: memoryContext }, ...content];
  next[userIndex] = { ...userMessage, content: contextualContent } as CoreMessage;
  return next;
}

export interface StreamFinishMetadata {
  /** True when the stream ended because the tab's tool set changed mid-stream.
   *  The caller should restart the conversation with fresh tools. */
  toolsChanged: boolean;
  /** True when the stream ended because the agent's maxSteps limit was reached.
   *  The caller should give the model one more text-only turn to summarize. */
  stepsExhausted: boolean;
}

export type StreamAbortReason = 'replaced' | 'remote-tools-changed';

export interface StreamCallbacks {
  // Text block callbacks - each text-start/end creates a separate message
  onTextBlockStart?: (blockId: string) => void;
  onTextBlockChunk?: (blockId: string, chunk: string) => void;
  onTextBlockEnd?: (blockId: string) => void;

  onFinish: (fullText: string, metadata?: StreamFinishMetadata) => void;
  onError: (error: Error) => void;
  onAbort?: (reason: StreamAbortReason) => void;
  /** Delivers the immutable workspace bootstrap established by this chat's first stream. */
  onWorkspaceContext?: (context: ConversationWorkspaceContext) => void;

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
    notifyAbort: (reason?: StreamAbortReason) => void;
  };
  private streamRequestSequence = 0;
  private latestAcceptedStreamSequence = 0;
  private pendingStreams = new Map<
    string,
    {
      controller: AbortController;
      notifyAbort: (reason?: StreamAbortReason) => void;
      sequence: number;
    }
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
   * List all configured agents
   */
  async getAvailableAgents(): Promise<AgentConfig[]> {
    return await this.configStorage.getAgents();
  }

  /**
   * Stream a chat completion from the specified agent
   * @param tabId - Optional tab ID to scope tools to a specific tab
   * @param streamId - Ownership token required to cancel this specific stream
   * @param workspaceContext - Fixed hidden bootstrap returned by this chat's first stream
   */
  async streamChat(
    agentId: string,
    messages: CoreMessage[],
    tabId: number | undefined,
    callbacks: StreamCallbacks,
    streamId: string = globalThis.crypto.randomUUID(),
    workspaceContext?: ConversationWorkspaceContext
  ): Promise<void> {
    const requestSequence = ++this.streamRequestSequence;
    let abortController: AbortController | undefined;
    let removeRemoteRevocationListener: (() => void) | undefined;
    let abortNotified = false;
    const notifyAbort = (reason: StreamAbortReason = 'replaced') => {
      if (abortNotified) return;
      abortNotified = true;
      try {
        callbacks.onAbort?.(reason);
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
      validateWorkspaceContext(workspaceContext, agentId);
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

      const establishingWorkspaceContext = workspaceContext === undefined;
      const memory = await raceWithAbort(
        getMemoryManager().resolve(agentId, {
          includeWorkspaceContext: establishingWorkspaceContext,
        }),
        pendingStream.controller.signal
      );
      let capturedWorkspaceContext: ConversationWorkspaceContext | undefined;
      if (establishingWorkspaceContext) {
        if (memory.state === 'unavailable') throw memory.error;
        capturedWorkspaceContext = captureWorkspaceContext(agentId, memory);
      }
      const conversationWorkspaceContext = workspaceContext ?? capturedWorkspaceContext;
      if (!conversationWorkspaceContext) throw new Error('Workspace bootstrap was not initialized');

      const runtime = createModelRuntime(agent);
      const toolRegistry = getToolRegistry();
      const toolSnapshot = toolRegistry.captureToolSnapshot(tabId);
      const memoryEnabled = memory.state === 'available';
      const allTools = {
        ...toolSnapshot.tools,
        ...(memoryEnabled ? createMemoryTools(memory.filesystem, memory.authoritySignal) : {}),
      };
      const mountedWorkspace =
        conversationWorkspaceContext.state === 'mounted' ? conversationWorkspaceContext : undefined;
      const conversation = mountedWorkspace
        ? attachMemoryContext(messages, mountedWorkspace.memory)
        : messages;
      const systemPrompt = composeSystemPrompt({
        mcpInstructions: toolSnapshot.mcpInstructions,
        ...(mountedWorkspace && { workspace: mountedWorkspace }),
        memoryEnabled: memoryEnabled || mountedWorkspace !== undefined,
      });
      const messagesWithSystem: CoreMessage[] = [
        { role: 'system', content: systemPrompt },
        ...conversation,
      ];

      // Register remote authority before ownership changes. Memory closures fail
      // their own calls after revocation; stale grounding does not cancel generation.
      const { remoteSession } = toolSnapshot;
      if (remoteSession.hasContext) {
        const onRemoteRevoked = () => {
          (abortController ?? pendingStream.controller).abort();
          notifyAbort('remote-tools-changed');
        };
        remoteSession.signal.addEventListener('abort', onRemoteRevoked, { once: true });
        removeRemoteRevocationListener = () =>
          remoteSession.signal.removeEventListener('abort', onRemoteRevoked);
        if (remoteSession.signal.aborted) onRemoteRevoked();
      }
      if (pendingStream.controller.signal.aborted) return;

      if (requestSequence < this.latestAcceptedStreamSequence) {
        notifyAbort();
        return;
      }

      // Only a fully prepared newer request may supersede the active provider stream.
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
        if (capturedWorkspaceContext !== undefined) {
          callbacks.onWorkspaceContext?.(capturedWorkspaceContext);
        }

        const hasTools = Object.keys(allTools).length > 0;
        let streamFailed = false;
        let streamFailure: unknown;

        const streamParams: Parameters<typeof streamText>[0] = {
          model: runtime.model,
          messages: messagesWithSystem,
          // Don't pass temperature when reasoning is enabled (SDK warning suggests this)
          ...(agent.reasoning?.enabled ? {} : { temperature: agent.temperature }),
          maxRetries: 2,
          abortSignal: abortController.signal,
          // AI SDK's default handler logs raw provider errors to the console.
          onError: ({ error }) => {
            streamFailed = true;
            streamFailure = error;
          },
          ...(hasTools && {
            tools: allTools,
            // Stop after current step if tools changed (navigation, etc.)
            // or after agent-configured step limit (default 10).
            stopWhen: ({ steps }) => {
              const decision = decideStreamStop(steps.length, agent.maxSteps, toolsInvalidated);
              if (decision.stepsExhausted) stepsExhausted = true;
              return decision.shouldStop;
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
              if (isReasoning && !isOpenAIProtocol(agent.apiProtocol)) {
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
            } else if (part.type === 'error') {
              throw part.error;
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

        // textStream omits non-text parts, so its SDK error callback is the only
        // signal that a provider failure occurred.
        if (streamFailed) throw streamFailure;
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
        abortController?.signal.aborted
      ) {
        notifyAbort();
        return;
      }
      callbacks.onError(publicAIRequestError(error));
    } finally {
      removeRemoteRevocationListener?.();
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
        temperature: 0.7,
      };

      const runtime = createModelRuntime(tempAgent);

      const testMessages: CoreMessage[] = [
        { role: 'user', content: 'Say "Connection successful" in 3 words or less.' },
      ];

      // A connection probe intentionally stops after the first text chunk. Own the request
      // with a fresh controller so every exit path also stops any remaining generation/billing.
      const testAbortController = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let streamFailed = false;
      let streamFailure: unknown;

      try {
        const result = await streamText({
          model: runtime.model,
          messages: testMessages,
          temperature: 0.7,
          maxRetries: 0,
          abortSignal: testAbortController.signal,
          onError: ({ error }) => {
            streamFailed = true;
            streamFailure = error;
          },
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

        if (streamFailed) throw streamFailure;
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
