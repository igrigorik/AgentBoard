import type { LanguageModelV2CallOptions, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { InvalidToolInputError, simulateReadableStream, stepCountIs, streamText } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { convertWebMCPToAISDKTool } from '../src/lib/webmcp/tool-bridge';
import { getTabManager } from '../src/lib/webmcp/lifecycle';

vi.mock('../src/lib/webmcp/lifecycle', () => ({
  getTabManager: vi.fn(),
}));

vi.mock('../src/lib/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('WebMCP Tool Bridge tab ownership', () => {
  const callTool = vi.fn();
  const inputSchema = {
    type: 'object',
    properties: {
      value: { type: 'number' },
      destructive: { type: 'boolean' },
    },
    additionalProperties: false,
  };
  const readPageDescriptor = {
    name: 'agentboard_read_page',
    description: 'Read the page',
    inputSchema: {
      type: 'object',
      properties: {
        maxLength: { type: 'number', minimum: 1_000, maximum: 100_000 },
      },
      additionalProperties: false,
    },
  };
  const malformedReadPageInput = {
    maxLength: 100_000,
    properties: { convertToMarkdown: { type: 'BOOLEAN' } },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes a page capability only while its exact catalog entry is active', async () => {
    const descriptor = { name: 'page_action', description: 'Page action', inputSchema };
    vi.mocked(getTabManager).mockReturnValue({
      getToolRegistry: (tabId: number) => (tabId === 100 ? { tools: [descriptor] } : undefined),
      callTool,
    } as any);
    callTool.mockResolvedValue('ok');

    const sdkTool = convertWebMCPToAISDKTool(descriptor, 100) as any;
    const controller = new AbortController();
    await expect(sdkTool.execute({ value: 1 }, { abortSignal: controller.signal })).resolves.toBe(
      'ok'
    );

    expect(callTool).toHaveBeenCalledWith(100, 'page_action', { value: 1 }, controller.signal);
  });

  it('fails closed instead of executing a same-named tool in another tab', async () => {
    vi.mocked(getTabManager).mockReturnValue({
      getToolRegistry: (tabId: number) =>
        tabId === 200 ? { tools: [{ name: 'page_action', inputSchema }] } : undefined,
      callTool,
    } as any);

    const sdkTool = convertWebMCPToAISDKTool(
      { name: 'page_action', description: 'Page action', inputSchema },
      100
    ) as any;

    await expect(sdkTool.execute({ destructive: true })).rejects.toThrow(
      'WebMCP tool execution failed'
    );
    expect(callTool).not.toHaveBeenCalled();
  });

  it('reports malformed model arguments without executing the page capability', async () => {
    const callTool = vi.fn().mockResolvedValue({ success: true });
    vi.mocked(getTabManager).mockReturnValue({
      getToolRegistry: () => ({ tools: [readPageDescriptor] }),
      callTool,
    } as unknown as ReturnType<typeof getTabManager>);

    const prompts: unknown[] = [];
    let invocation = 0;
    const model = {
      specificationVersion: 'v2' as const,
      provider: 'test',
      modelId: 'test',
      supportedUrls: {},
      doGenerate: vi.fn(),
      doStream: async (options: LanguageModelV2CallOptions) => {
        prompts.push(options.prompt);
        invocation += 1;
        const chunks: LanguageModelV2StreamPart[] =
          invocation === 1
            ? [
                { type: 'stream-start' as const, warnings: [] },
                {
                  type: 'tool-call' as const,
                  toolCallId: 'malformed-call',
                  toolName: readPageDescriptor.name,
                  input: JSON.stringify(malformedReadPageInput),
                },
                {
                  type: 'finish' as const,
                  finishReason: 'tool-calls' as const,
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ]
            : [
                { type: 'stream-start' as const, warnings: [] },
                { type: 'text-start' as const, id: 'text-1' },
                { type: 'text-delta' as const, id: 'text-1', delta: 'Corrected.' },
                { type: 'text-end' as const, id: 'text-1' },
                {
                  type: 'finish' as const,
                  finishReason: 'stop' as const,
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ];
        return {
          stream: simulateReadableStream({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    };

    const result = streamText({
      model,
      messages: [{ role: 'user', content: 'Read this page' }],
      tools: {
        [readPageDescriptor.name]: convertWebMCPToAISDKTool(readPageDescriptor, 100),
      },
      stopWhen: stepCountIs(2),
    });
    const parts = [];
    for await (const part of result.fullStream) parts.push(part);

    const invalidCall = parts.find((part) => part.type === 'tool-call');
    expect(invalidCall).toMatchObject({
      type: 'tool-call',
      toolCallId: 'malformed-call',
      invalid: true,
    });
    expect(
      invalidCall?.type === 'tool-call' && InvalidToolInputError.isInstance(invalidCall.error)
    ).toBe(true);
    expect(parts.some((part) => part.type === 'tool-error')).toBe(true);
    expect(prompts).toHaveLength(2);
    const continuationPrompt = JSON.stringify(prompts[1]);
    expect(continuationPrompt).toContain('Tool arguments do not match the declared schema');
    expect(continuationPrompt).toContain('# [additionalProperties]');
    expect(continuationPrompt).toContain(
      'Property \\"properties\\" does not match additional properties schema.'
    );
    expect(getTabManager).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('revalidates direct execute calls before touching the page capability', async () => {
    const callTool = vi.fn().mockResolvedValue({ success: true });
    vi.mocked(getTabManager).mockReturnValue({
      getToolRegistry: () => ({ tools: [readPageDescriptor] }),
      callTool,
    } as unknown as ReturnType<typeof getTabManager>);
    const sdkTool = convertWebMCPToAISDKTool(readPageDescriptor, 100) as any;

    await expect(sdkTool.execute(malformedReadPageInput)).rejects.toThrow(
      'WebMCP tool execution failed'
    );
    expect(getTabManager).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('invalidates stale closures when the same tab gets a replacement catalog', async () => {
    const staleDescriptor = { name: 'page_action', description: 'Old document', inputSchema };
    const replacementDescriptor = {
      name: 'page_action',
      description: 'Replacement document',
      inputSchema,
    };
    vi.mocked(getTabManager).mockReturnValue({
      getToolRegistry: (tabId: number) =>
        tabId === 100 ? { tools: [replacementDescriptor] } : undefined,
      callTool,
    } as any);

    const staleTool = convertWebMCPToAISDKTool(staleDescriptor, 100) as any;
    await expect(staleTool.execute({ destructive: true })).rejects.toThrow(
      'WebMCP tool execution failed'
    );
    expect(callTool).not.toHaveBeenCalled();
  });
});
