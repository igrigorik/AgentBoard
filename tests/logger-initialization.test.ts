import { beforeEach, describe, expect, it, vi } from 'vitest';

const baseLogger = vi.hoisted(() => ({
  setLevel: vi.fn(),
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('loglevel', () => ({ default: baseLogger }));

describe('logger initialization ordering', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('does not let a stale initial read overwrite a newer storage event', async () => {
    let finishInitialRead!: (result: { config?: unknown }) => void;
    let storageListener!: (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => void;
    vi.mocked(chrome.storage.local.get).mockImplementation(((_keys, callback) => {
      finishInitialRead = callback as unknown as typeof finishInitialRead;
    }) as typeof chrome.storage.local.get);
    const addListener = vi.fn((listener: typeof storageListener) => {
      storageListener = listener;
    });
    Object.defineProperty(chrome.storage, 'onChanged', {
      configurable: true,
      value: { addListener },
    });

    await import('../src/lib/logger');
    storageListener(
      {
        config: {
          newValue: { schemaVersion: 2, agents: [], logLevel: 'debug' },
        },
      },
      'local'
    );
    expect(baseLogger.setLevel).toHaveBeenLastCalledWith('debug');

    finishInitialRead({
      config: { schemaVersion: 2, agents: [], logLevel: 'error' },
    });
    expect(baseLogger.setLevel).toHaveBeenLastCalledWith('debug');
  });
});
