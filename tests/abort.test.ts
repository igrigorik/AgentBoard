import { describe, expect, it, vi } from 'vitest';
import { raceWithAbort } from '../src/lib/abort';

describe('raceWithAbort', () => {
  it('passes through operations when no signal is supplied', async () => {
    await expect(raceWithAbort(Promise.resolve('value'))).resolves.toBe('value');
    await expect(raceWithAbort(Promise.reject(new Error('failed')))).rejects.toThrow('failed');
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(raceWithAbort(new Promise(() => {}), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Aborted',
    });
  });

  it('settles cancellation without waiting for a non-cooperative operation', async () => {
    const controller = new AbortController();
    let resolveOperation!: (value: string) => void;
    const operation = new Promise<string>((resolve) => {
      resolveOperation = resolve;
    });

    const raced = raceWithAbort(operation, controller.signal);
    controller.abort();

    await expect(raced).rejects.toMatchObject({ name: 'AbortError' });
    resolveOperation('late value');
    await Promise.resolve();
  });

  it('removes its abort listener when the operation settles', async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');

    await expect(raceWithAbort(Promise.resolve('value'), controller.signal)).resolves.toBe('value');
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
