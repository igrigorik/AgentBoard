import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  waitForNavigation: vi.fn(),
}));

vi.mock('../src/lib/webmcp/lifecycle', () => ({
  getTabManager: () => ({ waitForNavigation: mocks.waitForNavigation }),
}));

vi.mock('../src/lib/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { getAllBuiltinTools } from '../src/lib/webmcp/builtin-tools';
import { createNavigateTool } from '../src/lib/webmcp/tools/navigate';

type NavigateTool = {
  execute: (input: { url: string }, context: { abortSignal?: AbortSignal }) => Promise<string>;
};

describe('agentboard_navigate cancellation', () => {
  it('is exposed in the built-in tool controls', () => {
    expect(getAllBuiltinTools()).toContainEqual(
      expect.objectContaining({ id: 'agentboard_navigate', type: 'system' })
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rechecks enablement before a captured tool can navigate', async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValueOnce({
      config: {
        schemaVersion: 2,
        agents: [],
        builtinScripts: [{ id: 'agentboard_navigate', enabled: false }],
      },
    } as never);
    chrome.tabs.update = vi.fn();
    const navigate = createNavigateTool(42) as unknown as NavigateTool;

    await expect(navigate.execute({ url: 'https://example.com' }, {})).rejects.toThrow(
      'Tool disabled'
    );
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('forwards the stream signal through navigation completion and tab APIs', async () => {
    const controller = new AbortController();
    mocks.waitForNavigation.mockResolvedValue({ url: 'https://example.com/final' });
    chrome.tabs.update = vi.fn().mockResolvedValue({ id: 42 });
    chrome.tabs.get = vi.fn().mockResolvedValue({ id: 42, title: 'Final page' });
    const navigate = createNavigateTool(42) as unknown as NavigateTool;

    await expect(
      navigate.execute({ url: 'https://example.com/start' }, { abortSignal: controller.signal })
    ).resolves.toBe('Navigated to https://example.com/final — "Final page"');

    expect(mocks.waitForNavigation).toHaveBeenCalledWith(42, 30000, controller.signal);
    expect(chrome.tabs.update).toHaveBeenCalledWith(42, {
      url: 'https://example.com/start',
    });
  });

  it('settles promptly when tab operations ignore cancellation', async () => {
    const controller = new AbortController();
    mocks.waitForNavigation.mockImplementation(
      (_tabId: number, _timeout: number, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    chrome.tabs.update = vi.fn(
      () => new Promise<chrome.tabs.Tab>(() => undefined)
    ) as typeof chrome.tabs.update;
    const navigate = createNavigateTool(42) as unknown as NavigateTool;

    const request = navigate.execute(
      { url: 'https://example.com' },
      { abortSignal: controller.signal }
    );
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(chrome.tabs.get).not.toHaveBeenCalled();
  });
});
