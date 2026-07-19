import { afterEach, describe, expect, it, vi } from 'vitest';
import { runStorageOperation, STORAGE_OPERATION_LOCK } from '../src/lib/storage/operation-queue';

const originalLocks = globalThis.navigator.locks;

afterEach(() => {
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: originalLocks,
  });
});

describe('storage operation queue', () => {
  it('acquires the origin-scoped exclusive Web Lock', async () => {
    const request = vi.fn(
      async (_name: string, _options: LockOptions, callback: () => Promise<string>) => callback()
    );
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      value: { request },
    });

    await expect(runStorageOperation(async () => 'done')).resolves.toBe('done');
    expect(request).toHaveBeenCalledWith(
      STORAGE_OPERATION_LOCK,
      { mode: 'exclusive' },
      expect.any(Function)
    );
  });

  it('continues after a lock request rejects', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('context closed'))
      .mockImplementationOnce(
        async (_name: string, _options: LockOptions, callback: () => Promise<string>) => callback()
      );
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      value: { request },
    });

    await expect(runStorageOperation(async () => 'unreachable')).rejects.toThrow('context closed');
    await expect(runStorageOperation(async () => 'recovered')).resolves.toBe('recovered');
  });
});
