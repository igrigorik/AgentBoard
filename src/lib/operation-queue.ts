/**
 * Preserve same-context call order while Web Locks extends mutual exclusion
 * across extension pages and the service worker.
 */
export function createOperationQueue(lockName: string) {
  let operations: Promise<void> = Promise.resolve();

  return function runOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const lockManager = globalThis.navigator?.locks;
      return lockManager
        ? await lockManager.request(lockName, { mode: 'exclusive' }, operation)
        : await operation();
    };
    const result = operations.then(run);
    operations = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
}
