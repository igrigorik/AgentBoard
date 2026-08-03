// @vitest-environment node

import { streamText, tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { AIClient } from '../src/lib/ai/client';
import { createModelRuntime } from '../src/lib/ai/model-runtime';
import type { ApiProtocol } from '../src/lib/ai/protocol';
import type { AgentConfig } from '../src/lib/storage/config';
import { convertWebMCPToAISDKTool } from '../src/lib/webmcp/tool-bridge';
import {
  eventSSE,
  sse,
  startAIWireServer,
  type CapturedWireRequest,
} from './helpers/ai-wire-server';

const probeTool = tool({
  description: 'Probe the provider wire contract',
  inputSchema: z.object({ value: z.string() }),
});

const probeJSONSchema = {
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
  additionalProperties: false,
  $schema: 'http://json-schema.org/draft-07/schema#',
};

const googleProbeJSONSchema = {
  required: ['value'],
  type: 'object',
  properties: { value: { type: 'string' } },
};

const shopifyUpdateCartSchema = {
  type: 'object',
  required: ['cart'],
  properties: {
    cart: {
      type: 'object',
      required: ['line_items'],
      properties: {
        line_items: {
          type: 'array',
          description: 'Items to add or update (1-10).',
          items: {
            type: 'object',
            properties: {
              item: {
                type: 'object',
                description: 'The merchandise to add.',
                properties: {
                  id: { type: 'string', description: 'ProductVariant GID.' },
                },
              },
              quantity: {
                type: 'integer',
                description: 'Quantity. Defaults to 1. Set 0 to remove.',
                minimum: 0,
                maximum: 100,
                default: 1,
              },
            },
          },
        },
      },
    },
  },
};

const shopifyShowVariantSchema = {
  type: 'object',
  required: ['catalog'],
  properties: {
    catalog: {
      type: 'object',
      description: 'Provide EITHER variant_id OR selected_options.',
      properties: {
        variant_id: {
          type: ['string', 'number'],
          description: 'ProductVariant GID or numeric variant ID.',
        },
      },
    },
  },
};

function shopifyWebMCPTools(): ToolSet {
  return {
    update_cart: convertWebMCPToAISDKTool(
      {
        name: 'update_cart',
        description: 'Update the cart',
        inputSchema: shopifyUpdateCartSchema,
      },
      100
    ),
    show_variant: convertWebMCPToAISDKTool(
      {
        name: 'show_variant',
        description: 'Show a variant',
        inputSchema: shopifyShowVariantSchema,
      },
      100
    ),
  };
}

const responseFixtures = {
  responses: [
    sse({
      type: 'response.created',
      response: { id: 'resp_1', created_at: 0, model: 'gpt-5-wire' },
    }),
    sse({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_1', phase: 'final_answer' },
    }),
    sse({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      delta: 'OK',
    }),
    sse({
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'message', id: 'msg_1', phase: 'final_answer' },
    }),
    sse({
      type: 'response.completed',
      response: {
        incomplete_details: null,
        usage: { input_tokens: 1, output_tokens: 1 },
        service_tier: null,
      },
    }),
    sse('[DONE]'),
  ],
  chat: [
    sse({
      id: 'chat_1',
      created: 0,
      model: 'gpt-4o-wire',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'OK' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    sse('[DONE]'),
  ],
  anthropic: [
    eventSSE('message_start', {
      type: 'message_start',
      message: { id: 'msg_1', model: 'claude-wire', usage: { input_tokens: 1 } },
    }),
    eventSSE('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    eventSSE('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'OK' },
    }),
    eventSSE('content_block_stop', { type: 'content_block_stop', index: 0 }),
    eventSSE('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    eventSSE('message_stop', { type: 'message_stop' }),
  ],
  google: [
    sse({
      candidates: [
        {
          content: { parts: [{ text: 'OK' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 1,
        totalTokenCount: 2,
      },
    }),
  ],
} as const;

function createAgent(
  apiProtocol: ApiProtocol,
  endpoint: string,
  overrides: Partial<AgentConfig> = {}
): AgentConfig {
  return {
    id: 'wire-agent',
    name: 'Wire Agent',
    provider: 'openai',
    apiKey: 'wire-secret-key',
    model: 'opaque-model',
    endpoint,
    apiProtocol,
    temperature: 0.7,
    ...overrides,
  };
}

async function captureWireRequest(
  apiProtocol: ApiProtocol,
  chunks: readonly string[],
  overrides: Partial<AgentConfig> = {},
  pathPrefix = '/nested/v1/',
  tools: ToolSet = { probe: probeTool }
): Promise<CapturedWireRequest> {
  const server = await startAIWireServer({ chunks: [...chunks] });
  const controller = new AbortController();

  try {
    const runtime = createModelRuntime(
      createAgent(apiProtocol, `${server.baseURL}${pathPrefix}`, overrides)
    );
    const streamErrors: unknown[] = [];
    const result = streamText({
      model: runtime.model,
      providerOptions: runtime.providerOptions,
      messages: [{ role: 'user', content: 'hello' }],
      maxOutputTokens: 32,
      maxRetries: 0,
      abortSignal: controller.signal,
      tools,
      toolChoice: 'auto',
      onError: ({ error }) => {
        streamErrors.push(error);
      },
    });

    let text = '';
    try {
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') text += part.text;
      }
    } finally {
      controller.abort();
    }

    expect(streamErrors).toEqual([]);
    expect(text).toBe('OK');
    const request = await server.request;
    await request.responseClosed;
    expect(server.getRequestCount()).toBe(1);
    return request;
  } finally {
    controller.abort();
    await server.close();
  }
}

describe('AI provider wire contracts', () => {
  it('sends an OpenAI Responses request with storage disabled', async () => {
    const request = await captureWireRequest('openai-responses', responseFixtures.responses, {
      provider: 'openai',
      model: 'gpt-5-wire',
      reasoning: {
        enabled: true,
        openai: { reasoningEffort: 'high', reasoningSummary: 'detailed' },
      },
    });

    expect(request.method).toBe('POST');
    expect(request.url).toBe('/nested/v1/responses');
    expect(request.headers.authorization).toBe('Bearer wire-secret-key');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.body).toEqual({
      model: 'gpt-5-wire',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }],
        },
      ],
      max_output_tokens: 32,
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'high', summary: 'detailed' },
      tools: [
        {
          type: 'function',
          name: 'probe',
          description: 'Probe the provider wire contract',
          parameters: probeJSONSchema,
          strict: false,
        },
      ],
      tool_choice: 'auto',
      stream: true,
    });
  });

  it('sends an OpenAI Chat Completions request without Responses fields', async () => {
    const request = await captureWireRequest('openai-chat-completions', responseFixtures.chat, {
      provider: 'openai',
      model: 'gpt-4o-wire',
      reasoning: {
        enabled: true,
        openai: { reasoningEffort: 'low', reasoningSummary: 'auto' },
      },
    });

    expect(request.url).toBe('/nested/v1/chat/completions');
    expect(request.headers.authorization).toBe('Bearer wire-secret-key');
    expect(request.body).toEqual({
      model: 'gpt-4o-wire',
      max_tokens: 32,
      reasoning_effort: 'low',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'probe',
            description: 'Probe the provider wire contract',
            parameters: probeJSONSchema,
            strict: false,
          },
        },
      ],
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('sends a native Anthropic Messages request', async () => {
    const request = await captureWireRequest('anthropic-messages', responseFixtures.anthropic, {
      provider: 'anthropic',
      model: 'claude-wire',
      reasoning: {
        enabled: true,
        anthropic: { thinkingBudgetTokens: 1024 },
      },
    });

    expect(request.url).toBe('/nested/v1/messages');
    expect(request.headers['x-api-key']).toBe('wire-secret-key');
    expect(request.headers['anthropic-version']).toBe('2023-06-01');
    expect(request.body).toEqual({
      model: 'claude-wire',
      max_tokens: 1056,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      ],
      tools: [
        {
          name: 'probe',
          description: 'Probe the provider wire contract',
          input_schema: probeJSONSchema,
        },
      ],
      tool_choice: { type: 'auto' },
      stream: true,
    });
  });

  it('sends a native Google Generative AI request', async () => {
    const request = await captureWireRequest('google-generative-ai', responseFixtures.google, {
      provider: 'google',
      model: 'gemini-wire',
      reasoning: {
        enabled: true,
        google: { thinkingBudget: 128, includeThoughts: true },
      },
    });

    expect(request.url).toBe('/nested/v1/models/gemini-wire:streamGenerateContent?alt=sse');
    expect(request.headers['x-goog-api-key']).toBe('wire-secret-key');
    expect(request.body).toEqual({
      generationConfig: {
        maxOutputTokens: 32,
        thinkingConfig: { thinkingBudget: 128, includeThoughts: true },
      },
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'probe',
              description: 'Probe the provider wire contract',
              parameters: googleProbeJSONSchema,
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    });
  });

  it('preserves Shopify WebMCP schemas on the OpenAI Responses wire', async () => {
    const request = await captureWireRequest(
      'openai-responses',
      responseFixtures.responses,
      { provider: 'openai', model: 'gpt-5-wire' },
      '/nested/v1/',
      shopifyWebMCPTools()
    );

    expect(request.body).toMatchObject({
      tools: [
        { name: 'update_cart', parameters: shopifyUpdateCartSchema },
        { name: 'show_variant', parameters: shopifyShowVariantSchema },
      ],
    });
  });

  it('preserves Shopify WebMCP schemas on the OpenAI Chat Completions wire', async () => {
    const request = await captureWireRequest(
      'openai-chat-completions',
      responseFixtures.chat,
      { provider: 'openai', model: 'gpt-4o-wire' },
      '/nested/v1/',
      shopifyWebMCPTools()
    );

    expect(request.body).toMatchObject({
      tools: [
        { function: { name: 'update_cart', parameters: shopifyUpdateCartSchema } },
        { function: { name: 'show_variant', parameters: shopifyShowVariantSchema } },
      ],
    });
  });

  it('preserves Shopify WebMCP schemas on the Anthropic wire', async () => {
    const request = await captureWireRequest(
      'anthropic-messages',
      responseFixtures.anthropic,
      { provider: 'anthropic', model: 'claude-wire' },
      '/nested/v1/',
      shopifyWebMCPTools()
    );

    expect(request.body).toMatchObject({
      tools: [
        { name: 'update_cart', input_schema: shopifyUpdateCartSchema },
        { name: 'show_variant', input_schema: shopifyShowVariantSchema },
      ],
    });
  });

  it('preserves Shopify-critical descriptions and union typing on the Google wire', async () => {
    const request = await captureWireRequest(
      'google-generative-ai',
      responseFixtures.google,
      { provider: 'google', model: 'gemini-wire' },
      '/nested/v1/',
      shopifyWebMCPTools()
    );

    expect(request.body).toMatchObject({
      tools: [
        {
          functionDeclarations: [
            {
              name: 'update_cart',
              parameters: {
                properties: {
                  cart: {
                    properties: {
                      line_items: {
                        description: 'Items to add or update (1-10).',
                        items: {
                          properties: {
                            item: { description: 'The merchandise to add.' },
                            quantity: {
                              description: 'Quantity. Defaults to 1. Set 0 to remove.',
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            {
              name: 'show_variant',
              parameters: {
                properties: {
                  catalog: {
                    description: 'Provide EITHER variant_id OR selected_options.',
                    properties: {
                      variant_id: {
                        description: 'ProductVariant GID or numeric variant ID.',
                        anyOf: [{ type: 'string' }, { type: 'number' }],
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      ],
    });
    // Google's current OpenAPI subset drops these keywords; local validation remains authoritative.
    expect(request.body).not.toMatchObject({
      tools: [
        {
          functionDeclarations: [
            {
              parameters: {
                properties: {
                  cart: {
                    properties: {
                      line_items: {
                        items: {
                          properties: { quantity: { minimum: 0, maximum: 100, default: 1 } },
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      ],
    });
  });

  it.each([
    {
      name: 'OpenAI Responses',
      apiProtocol: 'openai-responses',
      provider: 'openai',
      model: 'gpt-5-wire',
      chunks: responseFixtures.responses,
    },
    {
      name: 'OpenAI Chat Completions',
      apiProtocol: 'openai-chat-completions',
      provider: 'openai',
      model: 'gpt-4o-wire',
      chunks: responseFixtures.chat,
    },
    {
      name: 'Anthropic Messages',
      apiProtocol: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-wire',
      chunks: responseFixtures.anthropic,
    },
    {
      name: 'Google Generative AI',
      apiProtocol: 'google-generative-ai',
      provider: 'google',
      model: 'gemini-wire',
      chunks: responseFixtures.google,
    },
  ] as const)(
    'omits provider authentication for a keyless custom $name endpoint',
    async (testCase) => {
      const request = await captureWireRequest(testCase.apiProtocol, testCase.chunks, {
        provider: testCase.provider,
        model: testCase.model,
        apiKey: undefined,
      });

      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers['x-api-key']).toBeUndefined();
      expect(request.headers['x-goog-api-key']).toBeUndefined();
    }
  );

  it('normalizes a direct-style trailing-slash base URL', async () => {
    const request = await captureWireRequest(
      'openai-responses',
      responseFixtures.responses,
      { provider: 'openai', model: 'gpt-5-wire' },
      '/v1/'
    );

    expect(request.url).toBe('/v1/responses');
  });

  it.each([
    {
      name: 'OpenAI Responses',
      apiProtocol: 'openai-responses',
      model: 'gpt-5-wire',
      chunks: responseFixtures.responses,
      expectedPath: '/nested/v1/responses',
    },
    {
      name: 'OpenAI Chat Completions',
      apiProtocol: 'openai-chat-completions',
      model: 'gpt-4o-wire',
      chunks: responseFixtures.chat,
      expectedPath: '/nested/v1/chat/completions',
    },
    {
      name: 'Anthropic Messages',
      apiProtocol: 'anthropic-messages',
      model: 'claude-wire',
      chunks: responseFixtures.anthropic,
      expectedPath: '/nested/v1/messages',
    },
    {
      name: 'Google Generative AI',
      apiProtocol: 'google-generative-ai',
      model: 'gemini-wire',
      chunks: responseFixtures.google,
      expectedPath: '/nested/v1/models/gemini-wire:streamGenerateContent?alt=sse',
    },
  ] as const)('aborts a real $name connection probe after the first chunk', async (testCase) => {
    const server = await startAIWireServer({ chunks: [...testCase.chunks], keepOpen: true });

    try {
      const result = await AIClient.getInstance().testConnectionWithDetails({
        apiProtocol: testCase.apiProtocol,
        apiKey: 'wire-secret-key',
        model: testCase.model,
        endpoint: `${server.baseURL}/nested/v1`,
      });

      expect(result.success).toBe(true);
      const request = await server.request;
      expect(request.url).toBe(testCase.expectedPath);
      await request.responseClosed;
      expect(server.getRequestCount()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('fails closed before HTTP for an unknown protocol', async () => {
    const server = await startAIWireServer({ chunks: [...responseFixtures.responses] });

    try {
      const agent = createAgent('unknown-protocol' as ApiProtocol, `${server.baseURL}/nested/v1`);

      expect(() => createModelRuntime(agent)).toThrow(
        'Unsupported agent API protocol: unknown-protocol'
      );
      expect(server.getRequestCount()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('does not retry or fall back after a Chat connection-probe failure', async () => {
    const server = await startAIWireServer({
      statusCode: 404,
      contentType: 'application/json',
      chunks: [JSON.stringify({ error: { message: 'not found' } })],
    });

    try {
      const result = await AIClient.getInstance().testConnectionWithDetails({
        apiProtocol: 'openai-chat-completions',
        apiKey: 'wire-secret-key',
        model: 'gpt-4o-wire',
        endpoint: `${server.baseURL}/nested/v1`,
      });

      expect(result.success).toBe(false);
      const request = await server.request;
      expect(request.url).toBe('/nested/v1/chat/completions');
      expect(server.getRequestCount()).toBe(1);
    } finally {
      await server.close();
    }
  });
});
