import type { Tool as MCPTool } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { convertMCPToAISDKTool } from '../src/lib/mcp/tool-bridge';
import type { RemoteMCPSession, RemoteMCPToolCapability } from '../src/lib/mcp/manager';

const executeTool = vi.fn();

const mcpTool = {
  name: 'private_tool',
  description: 'Private tool',
  inputSchema: { type: 'object', properties: {} },
} as MCPTool;

const capability: RemoteMCPToolCapability = {
  serverName: 'private-server',
  tool: mcpTool,
};
const session = { executeTool } as unknown as RemoteMCPSession;

function convertedTool() {
  return convertMCPToAISDKTool(session, capability) as unknown as {
    execute: (
      input: Record<string, never>,
      context?: { abortSignal?: AbortSignal }
    ) => Promise<unknown>;
  };
}

describe('MCP tool privacy boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('converts protocol isError results into a fixed tool failure', async () => {
    const secret = 'secret MCP backend diagnostic';
    executeTool.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: secret }],
    });
    const converted = convertedTool();

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
    executeTool.mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: 'successful result' }],
    });
    const converted = convertedTool();
    const controller = new AbortController();

    await converted.execute({}, { abortSignal: controller.signal });

    expect(executeTool).toHaveBeenCalledWith(capability, {}, controller.signal);
  });

  it('preserves successful MCP content as tool output', async () => {
    executeTool.mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: 'successful result' }],
    });
    const converted = convertedTool();

    await expect(converted.execute({})).resolves.toBe('successful result');
  });
});
