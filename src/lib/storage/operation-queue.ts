import { createOperationQueue } from '../operation-queue';

/** Serialize operations that read or write configuration-bearing keys. */
export const STORAGE_OPERATION_LOCK = 'agentboard-storage-operation';

export const runStorageOperation = createOperationQueue(STORAGE_OPERATION_LOCK);
