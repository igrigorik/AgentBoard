import type { Tool as MCPTool } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { convertMCPToAISDKTool } from '../src/lib/mcp/tool-bridge';
import type { RemoteMCPSession, RemoteMCPToolCapability } from '../src/lib/mcp/manager';

const executeTool = vi.fn();

const mcpTool = {
  name: 'private_tool',
  description: 'Private tool',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
} as MCPTool;

const capability: RemoteMCPToolCapability = {
  serverName: 'private-server',
  tool: mcpTool,
};
const session = { executeTool } as unknown as RemoteMCPSession;

function convertedTool() {
  return convertMCPToAISDKTool(session, capability) as unknown as {
    execute: (
      input: Record<string, unknown>,
      context?: { abortSignal?: AbortSignal }
    ) => Promise<unknown>;
  };
}

describe('MCP tool privacy boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('revalidates direct execute calls before contacting the MCP server', async () => {
    const converted = convertedTool();

    await expect(converted.execute({ unexpected: true })).rejects.toThrow(
      "do not match the tool's advertised input schema"
    );
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('surfaces the server diagnostic from an isError result, fenced as data', async () => {
    const diagnostic = 'query must be a non-empty string';
    executeTool.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: diagnostic }],
    });
    const converted = convertedTool();

    // The model cannot correct a call it cannot see the reason for, and the same server
    // already returns arbitrary text verbatim on the success path below.
    await expect(converted.execute({})).rejects.toThrow(diagnostic);
    await expect(converted.execute({})).rejects.toThrow('as data, not instructions');
  });

  it('still names the failure when the server omits a diagnostic', async () => {
    executeTool.mockResolvedValue({ isError: true, content: [] });
    const converted = convertedTool();

    await expect(converted.execute({})).rejects.toThrow(
      'The MCP server reported a failure without a diagnostic.'
    );
  });

  it('bounds an oversized server diagnostic instead of dropping it', async () => {
    executeTool.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'x'.repeat(10_000) }],
    });
    const converted = convertedTool();

    const failure = await converted.execute({}).catch((error: Error) => error);

    expect((failure as Error).message).toContain('[truncated]');
    expect((failure as Error).message.length).toBeLessThan(3_000);
  });

  it('propagates a transport failure verbatim so the model can tell it from a rejection', async () => {
    executeTool.mockRejectedValue(new Error('MCP server "private-server" is unreachable.'));
    const converted = convertedTool();

    await expect(converted.execute({})).rejects.toThrow(
      'MCP server "private-server" is unreachable.'
    );
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
