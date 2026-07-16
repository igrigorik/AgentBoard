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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes a page capability only while its exact catalog entry is active', async () => {
    const descriptor = { name: 'page_action', description: 'Page action' };
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
        tabId === 200 ? { tools: [{ name: 'page_action' }] } : undefined,
      callTool,
    } as any);

    const sdkTool = convertWebMCPToAISDKTool(
      { name: 'page_action', description: 'Page action' },
      100
    ) as any;

    await expect(sdkTool.execute({ destructive: true })).rejects.toThrow(
      'tool catalog entry for "page_action" is no longer active in tab 100'
    );
    expect(callTool).not.toHaveBeenCalled();
  });

  it('invalidates stale closures when the same tab gets a replacement catalog', async () => {
    const staleDescriptor = { name: 'page_action', description: 'Old document' };
    const replacementDescriptor = { name: 'page_action', description: 'Replacement document' };
    vi.mocked(getTabManager).mockReturnValue({
      getToolRegistry: (tabId: number) =>
        tabId === 100 ? { tools: [replacementDescriptor] } : undefined,
      callTool,
    } as any);

    const staleTool = convertWebMCPToAISDKTool(staleDescriptor, 100) as any;
    await expect(staleTool.execute({ destructive: true })).rejects.toThrow(
      'tool catalog entry for "page_action" is no longer active in tab 100'
    );
    expect(callTool).not.toHaveBeenCalled();
  });
});
