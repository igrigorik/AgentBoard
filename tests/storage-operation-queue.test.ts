import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEMORY_MUTATION_LOCK } from '../src/lib/memory/filesystem';
import { runStorageOperation, STORAGE_OPERATION_LOCK } from '../src/lib/storage/operation-queue';

const originalLocks = globalThis.navigator.locks;

afterEach(() => {
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: originalLocks,
  });
});

describe('storage operation queue', () => {
  it('keeps memory mutations on a distinct lock to avoid import deadlock', () => {
    expect(MEMORY_MUTATION_LOCK).not.toBe(STORAGE_OPERATION_LOCK);
  });

  it('preserves FIFO ordering without Web Locks', async () => {
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      value: undefined,
    });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];

    const first = runStorageOperation(async () => {
      events.push('first:start');
      await firstBlocked;
      events.push('first:end');
    });
    const second = runStorageOperation(async () => {
      events.push('second');
    });
    await vi.waitFor(() => expect(events).toEqual(['first:start']));
    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

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
