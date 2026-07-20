import type { Tool as MCPTool } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTool: vi.fn(),
}));

vi.mock('../src/lib/mcp/manager', () => ({
  getRemoteMCPManager: () => ({ executeTool: mocks.executeTool }),
}));

import { convertMCPToAISDKTool } from '../src/lib/mcp/tool-bridge';

const mcpTool = {
  name: 'private_tool',
  description: 'Private tool',
  inputSchema: { type: 'object', properties: {} },
} as MCPTool;

describe('MCP tool privacy boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('converts protocol isError results into a fixed tool failure', async () => {
    const secret = 'secret MCP backend diagnostic';
    mocks.executeTool.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: secret }],
    });
    const converted = convertMCPToAISDKTool(mcpTool, 'private-server') as unknown as {
      execute: (input: Record<string, never>) => Promise<unknown>;
    };

    let failure: unknown;
    try {
      await converted.execute({});
    } catch (error) {
      failure = error;
    }

    expect(failure).toEqual(new Error('MCP tool execution failed'));
    expect(failure).not.toHaveProperty('responseBody');
    expect((failure as Error).message).not.toContain(secret);
  });

  it('forwards AI stream cancellation to the remote MCP manager', async () => {
    mocks.executeTool.mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: 'successful result' }],
    });
    const converted = convertMCPToAISDKTool(mcpTool, 'private-server') as unknown as {
      execute: (
        input: Record<string, never>,
        context: { abortSignal?: AbortSignal }
      ) => Promise<unknown>;
    };
    const controller = new AbortController();

    await converted.execute({}, { abortSignal: controller.signal });

    expect(mocks.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it('preserves successful MCP content as tool output', async () => {
    mocks.executeTool.mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: 'successful result' }],
    });
    const converted = convertMCPToAISDKTool(mcpTool, 'private-server') as unknown as {
      execute: (input: Record<string, never>) => Promise<unknown>;
    };

    await expect(converted.execute({})).resolves.toBe('successful result');
  });
});
