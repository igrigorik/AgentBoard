/**
 * AI Client - Service Worker LLM integration using Vercel AI SDK
 *
 * Architecture: Direct API calls from service worker using host_permissions to bypass CORS.
 * Streaming responses are sent back to sidebar via Chrome runtime messaging.
 */

import log from '../logger';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText, type LanguageModel, CoreMessage, stepCountIs, type JSONValue } from 'ai';
import type { AgentConfig } from '../storage/config';
import type { AIProvider, ToolCall } from '../../types';
import { ConfigStorage } from '../storage/config';
import { getToolRegistry } from '../webmcp/tool-registry';

// Interface for API error objects that may have additional properties
interface APIError extends Error {
  statusCode?: number;
  responseBody?: string | object;
}

export interface StreamCallbacks {
  // Text block callbacks - each text-start/end creates a separate message
  onTextBlockStart?: (blockId: string) => void;
  onTextBlockChunk?: (blockId: string, chunk: string) => void;
  onTextBlockEnd?: (blockId: string) => void;

  onFinish: (fullText: string) => void;
  onError: (error: Error) => void;

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
  private abortController?: AbortController;

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
   * Build provider-specific options for reasoning support
   * Uses dynamic configuration from agent.reasoning
   */
  private buildReasoningOptions(
    agent: AgentConfig
  ): Record<string, Record<string, JSONValue>> | undefined {
    if (!agent.reasoning?.enabled) return undefined;

    // Provider-specific reasoning configurations
    switch (agent.provider) {
      case 'anthropic':
        // Claude 4 models support thinking with budgetTokens
        return {
          anthropic: {
            thinking: {
              type: 'enabled',
              budgetTokens: agent.reasoning.anthropic?.thinkingBudgetTokens || 12000,
            },
          },
        };

      case 'openai': {
        // GPT-5 models support reasoningEffort and reasoningSummary
        const openaiConfig: {
          openai: {
            reasoningEffort: string;
            reasoningSummary?: string;
          };
        } = {
          openai: {
            reasoningEffort: agent.reasoning.openai?.reasoningEffort || 'medium',
          },
        };
        if (agent.reasoning.openai?.reasoningSummary) {
          openaiConfig.openai.reasoningSummary = agent.reasoning.openai.reasoningSummary;
        }
        return openaiConfig;
      }

      case 'google': {
        // Gemini 2.5 models support thinkingConfig
        return {
          google: {
            thinkingConfig: {
              thinkingBudget: agent.reasoning.google?.thinkingBudget ?? 8192,
              includeThoughts: agent.reasoning.google?.includeThoughts ?? true,
            },
          },
        };
      }

      default:
        return undefined;
    }
  }

  /**
   * Create a provider instance for a specific agent
   */
  private createProviderForAgent(agent: AgentConfig): () => LanguageModel {
    switch (agent.provider) {
      case 'openai': {
        const openai = createOpenAI({
          apiKey: agent.apiKey,
          baseURL: agent.endpoint,
        });
        return () => openai(agent.model);
      }

      case 'anthropic': {
        const anthropic = createAnthropic({
          apiKey: agent.apiKey,
          baseURL: agent.endpoint,
          headers: {
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          fetch: async (url, options) => {
            return globalThis.fetch(url, {
              ...options,
              headers: {
                ...options?.headers,
                'anthropic-dangerous-direct-browser-access': 'true',
              },
            });
          },
        });
        return () => anthropic(agent.model);
      }

      case 'google': {
        const google = createGoogleGenerativeAI({
          apiKey: agent.apiKey,
          baseURL: agent.endpoint,
        });
        return () => google(agent.model);
      }

      default:
        throw new Error(`Unsupported provider: ${agent.provider}`);
    }
  }

  /**
   * Check if an agent is configured and ready
   */
  async isAgentAvailable(agentId: string): Promise<boolean> {
    const agent = await this.configStorage.getAgent(agentId);
    return agent !== null && !!agent.apiKey;
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
   */
  async streamChat(
    agentId: string,
    messages: CoreMessage[],
    tabId: number | undefined,
    callbacks: StreamCallbacks
  ): Promise<void> {
    // Get the agent configuration
    const agent = await this.configStorage.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found. Please check your configuration.`);
    }

    if (!agent.apiKey) {
      throw new Error(
        `No API key configured for agent "${agent.name}". Please update in settings.`
      );
    }

    log.warn(`[AIClient] Using agent: ${agent.name} (${agent.provider})`);

    try {
      // Cancel any existing stream
      this.abortController?.abort();
      this.abortController = new AbortController();

      // Create provider for this agent
      const modelFactory = this.createProviderForAgent(agent);
      const model = modelFactory();

      // Add system prompt if configured
      const messagesWithSystem: CoreMessage[] = agent.systemPrompt
        ? [{ role: 'system', content: agent.systemPrompt }, ...messages]
        : messages;

      try {
        // Get tools from unified registry (already loaded by background)
        log.warn('[AIClient] Getting tools from unified registry for tab:', tabId);
        const toolRegistry = getToolRegistry();

        // Get tools scoped to the specific tab if tabId is provided
        // This ensures each sidebar only sees tools from its associated tab
        const allTools = tabId ? toolRegistry.getToolsForTab(tabId) : toolRegistry.getAllTools();
        const hasTools = Object.keys(allTools).length > 0;

        if (hasTools) {
          log.warn('[AIClient] Got tools from registry:', Object.keys(allTools));
        } else {
          log.warn('[AIClient] No tools available in registry');
        }

        // Build reasoning options if enabled
        const reasoningOptions = this.buildReasoningOptions(agent);

        const streamParams: Parameters<typeof streamText>[0] = {
          model,
          messages: messagesWithSystem,
          // Don't pass temperature when reasoning is enabled (SDK warning suggests this)
          ...(agent.reasoning?.enabled ? {} : { temperature: agent.temperature }),
          maxRetries: 2,
          abortSignal: this.abortController.signal,
          ...(hasTools && {
            tools: allTools,
            stopWhen: stepCountIs(5), // Allow up to 5 steps of tool calling and response generation
          }),
          // Add provider-specific reasoning options under providerOptions
          ...(reasoningOptions && {
            providerOptions: reasoningOptions,
          }),
        };

        log.warn('[AIClient] streamText parameters:', {
          modelProvider: agent.provider,
          messageCount: messagesWithSystem.length,
          hasTools,
          toolCount: hasTools ? Object.keys(allTools).length : 0,
          temperature: agent.temperature,
          reasoningEnabled: agent.reasoning?.enabled || false,
          reasoningOptions,
          fullStreamParams: streamParams,
        });

        if (agent.reasoning?.enabled) {
          log.warn('🧠 [AIClient] Reasoning is ENABLED for this session', {
            provider: agent.provider,
            model: agent.model,
            config: agent.reasoning,
            reasoningOptions,
            providerOptions: streamParams.providerOptions,
          });
        }

        const streamResult = streamText(streamParams as Parameters<typeof streamText>[0]);

        // Handle the stream with tool support
        const { textStream, fullStream } = await streamResult;

        let _fullText = '';
        let textBlockCount = 0; // Count text blocks for debugging
        let currentTextBlockId: string | null = null; // Track the active text block
        let isReasoning = false; // Track if we're currently in reasoning phase
        let currentReasoningId: string | undefined; // Track the current reasoning segment ID
        let reasoningBlockCount = 0; // Count reasoning blocks
        let reasoningTokens: number | undefined; // Track reasoning token usage

        try {
          // Use fullStream for tools OR reasoning support
          if (hasTools || agent.reasoning?.enabled) {
            for await (const part of fullStream) {
              // Debug log to see what events we're actually getting
              log.warn('[AIClient] Stream event:', part.type, {
                type: part.type,
                hasText: !!(part as Record<string, unknown>).text,
                hasTextDelta: !!(part as Record<string, unknown>).textDelta,
                hasDelta: !!(part as Record<string, unknown>).delta,
                hasProviderMetadata: !!(part as Record<string, unknown>).providerMetadata,
                providerMetadata: (part as Record<string, unknown>).providerMetadata,
                fullPart: part,
              });

              // Handle reasoning events from various providers
              // Different providers emit different event types for reasoning
              // First, let's check what event types we're actually seeing
              const eventType = (part as Record<string, unknown>).type;

              // Handle OpenAI reasoning-start event (marks beginning but no content)
              if (eventType === 'reasoning-start') {
                log.warn('🧠 [Reasoning] OpenAI reasoning-start event detected', part);
                // OpenAI uses reasoning-start to mark beginning, but content comes in reasoning-delta
                continue;
              }

              // Handle OpenAI reasoning-end event (marks end of a segment)
              if (eventType === 'reasoning-end') {
                log.warn('🧠 [Reasoning] OpenAI reasoning-end event detected', part);
                if (isReasoning) {
                  log.warn(`🧠 [Reasoning] Ending segment ${currentReasoningId}`);
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

                log.warn('🧠 [Reasoning] Found reasoning event type:', eventType, {
                  id: reasoningId,
                  segmentId,
                  currentReasoningId,
                  part,
                });

                // Check if this is a new reasoning segment
                if (segmentId && segmentId !== currentReasoningId) {
                  // End previous reasoning segment if one was active
                  if (isReasoning && currentReasoningId) {
                    log.warn(
                      `🧠 [Reasoning] Ending segment ${currentReasoningId} (new segment ${segmentId} starting)`
                    );
                    callbacks.onReasoningEnd?.();
                    isReasoning = false;
                  }

                  // Start new reasoning segment
                  currentReasoningId = segmentId;
                  reasoningBlockCount++;
                  isReasoning = true;
                  log.warn(
                    `🧠 [Reasoning] Starting segment ${segmentId} (block #${reasoningBlockCount})`
                  );
                  callbacks.onReasoningStart?.();
                }

                const reasoningText =
                  (partData.text as string) ||
                  (partData.textDelta as string) ||
                  (partData.delta as string) ||
                  '';

                if (reasoningText) {
                  log.warn('🧠 [Reasoning] Chunk:', reasoningText.substring(0, 100));
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
                log.warn('🧠 [Reasoning] Found reasoning event type:', eventType, part);

                const reasoningText =
                  ((part as Record<string, unknown>).text as string) ||
                  ((part as Record<string, unknown>).textDelta as string) ||
                  ((part as Record<string, unknown>).delta as string) ||
                  '';

                if (!isReasoning) {
                  isReasoning = true;
                  reasoningBlockCount++;
                  log.warn(
                    `🧠 [Reasoning] Started (via ${eventType} event, block #${reasoningBlockCount})`
                  );
                  callbacks.onReasoningStart?.();
                }

                if (reasoningText) {
                  log.warn('🧠 [Reasoning] Chunk:', reasoningText.substring(0, 100));
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
                log.warn('🧠 [Reasoning] Found reasoning in providerMetadata:', metadata);
                if (!isReasoning) {
                  isReasoning = true;
                  callbacks.onReasoningStart?.();
                }
              }

              // Handle text blocks as separate messages
              if (part.type === 'text-start') {
                // For non-OpenAI providers, end reasoning if it's still active
                // OpenAI sends explicit reasoning-end events, so we don't need this
                if (isReasoning && agent.provider !== 'openai') {
                  log.warn('🧠 [Reasoning] Ended (text-start detected)');
                  callbacks.onReasoningEnd?.(reasoningTokens ? { reasoningTokens } : undefined);
                  isReasoning = false;
                  currentReasoningId = undefined;
                }

                textBlockCount++;
                // Always use our own incrementing ID since SDK reuses "0" across steps
                currentTextBlockId = `block-${textBlockCount}`;
                log.warn(
                  `📝 [Text Block #${textBlockCount}] Starting with ID: ${currentTextBlockId} (SDK id: ${(part as Record<string, unknown>).id})`
                );

                // Always treat text blocks as regular response blocks
                log.warn(`📝 [Text Block #${textBlockCount}] Regular response block`);
                callbacks.onTextBlockStart?.(currentTextBlockId);
              } else if (part.type === 'text-end') {
                // Use the current block ID that was set at text-start
                if (currentTextBlockId) {
                  log.warn(`📝 [Text Block] Ending block: ${currentTextBlockId}`);
                  // Emit text block end event
                  callbacks.onTextBlockEnd?.(currentTextBlockId);

                  // Clear the current block ID
                  currentTextBlockId = null;
                } else {
                  log.warn('⚠️ [Text Block] text-end without current block ID');
                }
              } else if (part.type === 'text-delta') {
                // If reasoning was active and now text is coming, end reasoning
                if (isReasoning) {
                  log.warn('🧠 [Reasoning] Ended (text-delta detected)');
                  callbacks.onReasoningEnd?.(reasoningTokens ? { reasoningTokens } : undefined);
                  isReasoning = false;
                }

                const chunk = part.text || '';

                // Use the current block ID that was set at text-start
                if (!currentTextBlockId) {
                  log.warn('⚠️ [Text Block] text-delta without current block ID, creating one');
                  textBlockCount++;
                  currentTextBlockId = `block-${textBlockCount}`;
                  callbacks.onTextBlockStart?.(currentTextBlockId);
                }

                log.warn(
                  `📝 [Text Block] Delta for block: ${currentTextBlockId}, chunk: "${chunk.substring(0, 50)}..."`
                );

                // Emit text block chunk event for interleaved display
                callbacks.onTextBlockChunk?.(currentTextBlockId, chunk);

                _fullText += chunk;
              } else if ((part as Record<string, unknown>).type === 'finish-step') {
                // Step finished
                log.warn('📍 [Step] Finished step');
              } else if ((part as Record<string, unknown>).type === 'start-step') {
                // New step starting
                log.warn('📍 [Step] Starting new step');
              } else if (part.type === 'tool-call') {
                log.warn('🔧 [MCP Tool Call]', {
                  tool: part.toolName,
                  input: part.input,
                  callId: part.toolCallId,
                });

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
                log.warn('✅ [MCP Tool Result]', {
                  tool: part.toolName,
                  output: part.output,
                  callId: part.toolCallId,
                });

                // Emit structured tool result event if callback exists
                if (callbacks.onToolResult) {
                  callbacks.onToolResult({
                    id: part.toolCallId,
                    output: part.output,
                    status: 'success',
                  });
                }
                // The AI should continue generating text after tool results
              } else if (part.type === 'finish') {
                // Handle finish event with usage data
                // The finish event has totalUsage property according to SDK types
                const usage = part.totalUsage || (part as Record<string, unknown>).usage || {};
                reasoningTokens = (usage as Record<string, unknown>)?.reasoningTokens as
                  | number
                  | undefined;

                // If reasoning is still active at finish (no text phase), end it now
                if (isReasoning) {
                  log.warn('🧠 [Reasoning] Ended (stream finished)');
                  callbacks.onReasoningEnd?.({ reasoningTokens: reasoningTokens || 0 });
                  isReasoning = false;
                }

                log.warn('🧠 [Reasoning] Stream finished', {
                  reasoningTokens,
                  totalTokens: usage?.totalTokens,
                });
              }
            }
          } else {
            // No tools, use simple text stream
            for await (const chunk of textStream) {
              _fullText += chunk;
              // Legacy mode - no structured events, just raw text
            }
          }

          callbacks.onFinish(_fullText);
        } catch (iterationError) {
          log.error('[AIClient] Error during stream iteration:', iterationError);

          // Check for API call errors and extract useful details
          const errorObj = iterationError as APIError;
          if (errorObj.statusCode && errorObj.responseBody) {
            // Parse responseBody if it's a string
            let parsedResponseBody;
            try {
              parsedResponseBody =
                typeof errorObj.responseBody === 'string'
                  ? JSON.parse(errorObj.responseBody)
                  : errorObj.responseBody;
            } catch {
              parsedResponseBody = errorObj.responseBody;
            }

            // Enhanced error message for proxy/gateway errors
            if (parsedResponseBody?.error && parsedResponseBody?.location === 'proxy') {
              const proxyError = new Error(
                `Proxy/Gateway Error: ${parsedResponseBody.reason || parsedResponseBody.error}\n` +
                  `Details: ${parsedResponseBody.description || 'No additional details'}`
              );
              throw proxyError;
            }
          }

          throw iterationError;
        }
      } catch (streamError) {
        log.error('[AIClient] Stream error:', streamError);
        throw streamError;
      }

      // Note: onFinish above handles the completion
    } catch (error) {
      log.error('[AIClient] Error in streamChat:', error);

      if (error instanceof Error) {
        log.error('[AIClient] Error message:', error.message);

        // Check for API call errors and extract useful details (same as iteration block)
        const errorObj = error as APIError;
        if (errorObj.statusCode && errorObj.responseBody) {
          // Parse responseBody if it's a string
          let parsedResponseBody;
          try {
            parsedResponseBody =
              typeof errorObj.responseBody === 'string'
                ? JSON.parse(errorObj.responseBody)
                : errorObj.responseBody;
          } catch {
            parsedResponseBody = errorObj.responseBody;
          }

          // Enhanced error message for proxy/gateway errors
          if (parsedResponseBody?.error && parsedResponseBody?.location === 'proxy') {
            const proxyError = new Error(
              `Proxy/Gateway Error: ${parsedResponseBody.reason || parsedResponseBody.error}\n` +
                `Details: ${parsedResponseBody.description || 'No additional details'}`
            );
            callbacks.onError(proxyError);
            return;
          }
        }

        // Enhance error messages for common issues
        if (error.message.includes('401') || error.message.includes('Unauthorized')) {
          const endpointInfo = agent.endpoint ? ` (using custom endpoint: ${agent.endpoint})` : '';
          callbacks.onError(
            new Error(
              `Invalid API key for agent "${agent.name}"${endpointInfo}. Please check your settings.`
            )
          );
        } else if (error.message.includes('429')) {
          callbacks.onError(
            new Error(`Rate limit exceeded for agent "${agent.name}". Please try again later.`)
          );
        } else if (
          error.message.includes('ECONNREFUSED') ||
          error.message.includes('fetch failed')
        ) {
          const endpointInfo = agent.endpoint ? ` at ${agent.endpoint}` : '';
          callbacks.onError(
            new Error(
              `Cannot connect to ${agent.provider} service${endpointInfo}. Please check the endpoint is accessible.`
            )
          );
        } else if (error.message.includes('404') && agent.endpoint) {
          callbacks.onError(
            new Error(
              `Endpoint not found at ${agent.endpoint}. Please verify the custom endpoint URL and path.`
            )
          );
        } else if (error.message.includes('abort')) {
          // Stream was cancelled, not an error
          return;
        } else {
          callbacks.onError(error);
        }
      } else {
        callbacks.onError(new Error('An unknown error occurred'));
      }
    }
  }

  /**
   * Cancel the current streaming operation
   */
  cancelStream(): void {
    this.abortController?.abort();
  }

  /**
   * Test connection with provided agent details (for new agents before saving)
   */
  async testConnectionWithDetails(details: {
    provider: AIProvider;
    apiKey: string;
    model: string;
    endpoint?: string;
  }): Promise<{ success: boolean; message: string }> {
    try {
      // Create temporary agent config for testing
      const tempAgent: AgentConfig = {
        id: 'temp-test',
        name: 'Test Agent',
        provider: details.provider,
        apiKey: details.apiKey,
        model: details.model,
        endpoint: details.endpoint,
        systemPrompt: '',
        temperature: 0.7,
        maxTokens: 1000,
      };

      const modelFactory = this.createProviderForAgent(tempAgent);
      const model = modelFactory();

      const testMessages: CoreMessage[] = [
        { role: 'user', content: 'Say "Connection successful" in 3 words or less.' },
      ];

      // Create fresh abort controller for test (don't reuse instance one which might be aborted)
      const testAbortController = new AbortController();

      const result = await streamText({
        model,
        messages: testMessages,
        temperature: 0.7,
        maxRetries: 1,
        abortSignal: testAbortController.signal,
      });

      // Actually consume the stream to verify connection works
      // Use a timeout to prevent hanging forever
      const timeoutPromise = new Promise<boolean>((_, reject) => {
        setTimeout(() => reject(new Error('Test timeout after 10 seconds')), 10000);
      });

      const streamPromise = (async () => {
        let receivedData = false;
        for await (const _chunk of result.textStream) {
          receivedData = true;
          break; // Just need first chunk to verify connection
        }
        return receivedData;
      })();

      const receivedData = await Promise.race([streamPromise, timeoutPromise]);

      if (!receivedData) {
        return {
          success: false,
          message: `Connection established but no response from ${details.provider}`,
        };
      }

      const endpointInfo = details.endpoint ? ` via ${details.endpoint}` : '';
      return {
        success: true,
        message: `Successfully connected to ${details.provider} (${details.model})${endpointInfo}`,
      };
    } catch (error) {
      log.error('[AIClient] Test connection failed:', error);

      if (error instanceof Error) {
        if (error.message.includes('401') || error.message.includes('Unauthorized')) {
          return {
            success: false,
            message: `Invalid API key for ${details.provider}. Please check your credentials.`,
          };
        }

        if (error.message.includes('404') || error.message.includes('model')) {
          return {
            success: false,
            message: `Model '${details.model}' not found for ${details.provider}. Please check the model name.`,
          };
        }

        if (error.message.includes('aborted') || error.name === 'AbortError') {
          return {
            success: false,
            message: `Test was cancelled or aborted. Try again.`,
          };
        }

        if (error.message.includes('timeout')) {
          return {
            success: false,
            message: `Connection timeout. The ${details.provider} API took too long to respond.`,
          };
        }

        return {
          success: false,
          message: `Connection failed: ${error.message}`,
        };
      }

      return {
        success: false,
        message: 'Connection test failed with unknown error',
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
          message: `Agent ${agentId} not found`,
        };
      }

      const testMessages: CoreMessage[] = [
        { role: 'user', content: 'Say "Connection successful" in 3 words or less.' },
      ];

      await this.streamChat(agentId, testMessages, undefined, {
        onFinish: (_fullText: string) => {
          // Success handled below, fullText ignored for test
        },
        onError: (error) => {
          throw error;
        },
      });

      const endpointInfo = agent.endpoint ? ` via ${agent.endpoint}` : '';
      return {
        success: true,
        message: `✓ Agent "${agent.name}" connected successfully${endpointInfo}`,
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection test failed',
      };
    }
  }

  /**
   * Validate agent configuration
   */
  validateAgentConfig(agent: AgentConfig): string[] {
    const errors: string[] = [];

    if (!agent.name.trim()) {
      errors.push('Agent name is required');
    }

    if (!agent.apiKey) {
      errors.push('API key is required');
    }

    if (!agent.model) {
      errors.push('Model selection is required');
    }

    if (agent.temperature < 0 || agent.temperature > 2) {
      errors.push('Temperature must be between 0 and 2');
    }

    if (agent.maxTokens < 1) {
      errors.push('Max tokens must be at least 1');
    }

    // Validate custom endpoint URL if provided
    if (agent.endpoint) {
      try {
        const url = new URL(agent.endpoint);
        if (!['http:', 'https:'].includes(url.protocol)) {
          errors.push('Custom endpoint must use http:// or https:// protocol');
        }
      } catch {
        errors.push('Custom endpoint must be a valid URL');
      }
    }

    // Provider-specific validation
    switch (agent.provider) {
      case 'openai':
        if (agent.apiKey && !agent.apiKey.startsWith('sk-')) {
          errors.push('OpenAI API key should start with "sk-"');
        }
        // Provide helpful hints for common OpenAI-compatible endpoints
        if (agent.endpoint) {
          if (!agent.endpoint.includes('/v1') && !agent.endpoint.endsWith('/v1')) {
            errors.push(
              'OpenAI-compatible endpoints typically require "/v1" path (e.g., http://localhost:1234/v1)'
            );
          }
        }
        break;
      case 'anthropic':
        if (agent.apiKey && !agent.apiKey.includes('sk-ant-')) {
          errors.push('Anthropic API key should contain "sk-ant-"');
        }
        break;
      case 'google':
        // Google API keys don't have a consistent prefix
        break;
    }

    return errors;
  }
}
