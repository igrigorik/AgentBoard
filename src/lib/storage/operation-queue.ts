/**
 * Serialize operations that read or write configuration-bearing keys. The local
 * queue preserves call order; Web Locks extends mutual exclusion across extension
 * pages and the service worker and releases automatically if a context exits.
 */
export const STORAGE_OPERATION_LOCK = 'agentboard-storage-operation';

let operations: Promise<void> = Promise.resolve();

async function runWithCrossContextLock<T>(operation: () => Promise<T>): Promise<T> {
  const lockManager = globalThis.navigator?.locks;
  return lockManager
    ? lockManager.request(STORAGE_OPERATION_LOCK, { mode: 'exclusive' }, operation)
    : operation();
}

export function runStorageOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = operations.then(() => runWithCrossContextLock(operation));
  operations = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
