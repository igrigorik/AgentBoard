import type { MemoryDirectoryHandle } from './filesystem';

const DATABASE_NAME = 'agentboard-memory';
const DATABASE_VERSION = 1;
const BINDING_STORE = 'bindings';

export interface MemoryBinding {
  agentId: string;
  handle: MemoryDirectoryHandle;
}

export interface MemoryBindingRepository {
  get(agentId: string): Promise<MemoryBinding | undefined>;
  list(): Promise<MemoryBinding[]>;
  put(binding: MemoryBinding): Promise<void>;
  delete(agentId: string): Promise<void>;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB aborted'));
  });
}

/** FileSystemDirectoryHandle is structured-cloneable and is stored directly, never mirrored. */
export class IndexedDBMemoryBindingRepository implements MemoryBindingRepository {
  private databasePromise?: Promise<IDBDatabase>;
  private database?: IDBDatabase;

  private resetDatabase(database: IDBDatabase): void {
    if (this.database !== database) return;
    this.database = undefined;
    this.databasePromise = undefined;
    database.close();
  }

  private transaction(database: IDBDatabase, mode: IDBTransactionMode): IDBTransaction {
    try {
      return database.transaction(BINDING_STORE, mode);
    } catch (error) {
      this.resetDatabase(database);
      throw error;
    }
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;

    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(BINDING_STORE)) {
          request.result.createObjectStore(BINDING_STORE, { keyPath: 'agentId' });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        this.database = database;
        database.onversionchange = () => this.resetDatabase(database);
        database.onclose = () => this.resetDatabase(database);
        resolve(database);
      };
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    }).catch((error) => {
      this.databasePromise = undefined;
      throw error;
    });
    this.databasePromise = opening;
    return opening;
  }

  async get(agentId: string): Promise<MemoryBinding | undefined> {
    const database = await this.open();
    const transaction = this.transaction(database, 'readonly');
    const done = transactionDone(transaction);
    const [result] = await Promise.all([
      requestResult(
        transaction.objectStore(BINDING_STORE).get(agentId) as IDBRequest<MemoryBinding | undefined>
      ),
      done,
    ]);
    return result;
  }

  async list(): Promise<MemoryBinding[]> {
    const database = await this.open();
    const transaction = this.transaction(database, 'readonly');
    const done = transactionDone(transaction);
    const [result] = await Promise.all([
      requestResult(transaction.objectStore(BINDING_STORE).getAll() as IDBRequest<MemoryBinding[]>),
      done,
    ]);
    return result;
  }

  async put(binding: MemoryBinding): Promise<void> {
    const database = await this.open();
    const transaction = this.transaction(database, 'readwrite');
    const done = transactionDone(transaction);
    await Promise.all([requestResult(transaction.objectStore(BINDING_STORE).put(binding)), done]);
  }

  async delete(agentId: string): Promise<void> {
    const database = await this.open();
    const transaction = this.transaction(database, 'readwrite');
    const done = transactionDone(transaction);
    await Promise.all([
      requestResult(transaction.objectStore(BINDING_STORE).delete(agentId)),
      done,
    ]);
  }
}
