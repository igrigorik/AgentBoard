import { IndexedDBMemoryBindingRepository, type MemoryBindingRepository } from './bindings';
import {
  initializeMemoryRoot,
  MemoryFileError,
  MemoryFilesystem,
  runMemoryMutation,
  type MemoryDirectoryHandle,
  type MemoryFileSnapshot,
} from './filesystem';

export type MemoryUnavailableReason =
  | 'permission-required'
  | 'root-unavailable'
  | 'incompatible-layout'
  | 'memory-too-large'
  | 'binding-changed'
  | 'binding-storage-unavailable';

export type MemoryMountErrorCode =
  | 'PERMISSION_REQUIRED'
  | 'ROOT_UNAVAILABLE'
  | 'INCOMPATIBLE_LAYOUT'
  | 'MEMORY_TOO_LARGE'
  | 'NESTED_ROOT'
  | 'BINDING_CHANGED'
  | 'BINDING_STORAGE_UNAVAILABLE';

export class MemoryMountError extends Error {
  constructor(readonly code: MemoryMountErrorCode) {
    super(memoryMountErrorMessage(code));
    this.name = 'MemoryMountError';
  }
}

function memoryMountErrorMessage(code: MemoryMountErrorCode): string {
  switch (code) {
    case 'PERMISSION_REQUIRED':
      return 'This agent’s memory folder needs to be reconnected in Settings.';
    case 'ROOT_UNAVAILABLE':
      return 'This agent’s memory folder is unavailable. Reconnect it in Settings.';
    case 'INCOMPATIBLE_LAYOUT':
      return 'This memory folder has an incompatible MEMORY.md or memory entry.';
    case 'MEMORY_TOO_LARGE':
      return 'MEMORY.md exceeds AgentBoard’s 64 KiB limit.';
    case 'NESTED_ROOT':
      return 'Choose the same workspace or a separate folder; parent and child memory folders cannot be connected to different agents.';
    case 'BINDING_CHANGED':
      return 'The agent’s memory folder changed. Send the request again.';
    default:
      return 'AgentBoard could not access its memory-folder bindings.';
  }
}

export type ResolvedMemory =
  | { state: 'unmounted' }
  | {
      state: 'available';
      rootName: string;
      filesystem: MemoryFilesystem;
      memoryFile?: MemoryFileSnapshot;
      authoritySignal: AbortSignal;
    }
  | {
      state: 'unavailable';
      rootName?: string;
      reason: MemoryUnavailableReason;
      error: MemoryMountError;
    };

function mapFilesystemFailure(error: unknown): MemoryMountError {
  if (!(error instanceof MemoryFileError)) return new MemoryMountError('ROOT_UNAVAILABLE');
  if (error.code === 'FILE_TOO_LARGE') return new MemoryMountError('MEMORY_TOO_LARGE');
  if (
    error.code === 'INVALID_TEXT' ||
    error.code === 'NOT_A_FILE' ||
    error.code === 'NOT_A_DIRECTORY'
  ) {
    return new MemoryMountError('INCOMPATIBLE_LAYOUT');
  }
  return new MemoryMountError('ROOT_UNAVAILABLE');
}

async function queryReadWritePermission(handle: MemoryDirectoryHandle): Promise<PermissionState> {
  try {
    return await handle.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

async function rootsAreNested(
  first: MemoryDirectoryHandle,
  second: MemoryDirectoryHandle
): Promise<boolean> {
  try {
    if (await first.isSameEntry(second)) return false;
  } catch {
    // resolve() below is sufficient to distinguish same, nested, and disjoint roots.
  }
  const [secondPath, firstPath] = await Promise.all([first.resolve(second), second.resolve(first)]);
  return (
    (secondPath !== null && secondPath.length > 0) || (firstPath !== null && firstPath.length > 0)
  );
}

/**
 * Owns per-agent directory capabilities; bindings may share an exact root, but
 * each agent keeps an independently revocable lease and file contents never enter IndexedDB.
 */
export class MemoryManager {
  private readonly leases = new Map<
    string,
    { handle: MemoryDirectoryHandle; controller: AbortController }
  >();
  // Epochs intentionally survive disconnects; resetting one could let a stale
  // resolution captured before deletion match a future binding's generation.
  private readonly agentAuthorityEpochs = new Map<string, number>();
  private readonly resolvingBindings = new Map<string, number>();
  private globalAuthorityEpoch = 0;

  constructor(
    private readonly repository: MemoryBindingRepository = new IndexedDBMemoryBindingRepository()
  ) {}

  async connect(agentId: string, handle: MemoryDirectoryHandle): Promise<void> {
    if ((await queryReadWritePermission(handle)) !== 'granted') {
      throw new MemoryMountError('PERMISSION_REQUIRED');
    }

    try {
      await runMemoryMutation(async () => {
        const bindings = await this.repository.list();
        for (const binding of bindings) {
          if (binding.agentId === agentId) continue;
          if (await rootsAreNested(binding.handle, handle)) {
            throw new MemoryMountError('NESTED_ROOT');
          }
        }

        try {
          await initializeMemoryRoot(handle);
        } catch (error) {
          throw mapFilesystemFailure(error);
        }
        await this.repository.put({ agentId, handle });
      });
      this.revoke(agentId);
    } catch (error) {
      if (error instanceof MemoryMountError) throw error;
      throw new MemoryMountError('BINDING_STORAGE_UNAVAILABLE');
    }
  }

  async disconnect(agentId: string): Promise<void> {
    try {
      await runMemoryMutation(() => this.repository.delete(agentId));
      this.revoke(agentId);
    } catch {
      throw new MemoryMountError('BINDING_STORAGE_UNAVAILABLE');
    }
  }

  /** Renew a persisted handle only from a visible user-activated extension page. */
  async renewPermission(agentId: string): Promise<void> {
    let binding;
    try {
      binding = await this.repository.get(agentId);
    } catch {
      throw new MemoryMountError('BINDING_STORAGE_UNAVAILABLE');
    }
    if (!binding) throw new MemoryMountError('ROOT_UNAVAILABLE');

    let permission: PermissionState;
    try {
      permission = await binding.handle.requestPermission({ mode: 'readwrite' });
    } catch {
      permission = 'denied';
    }
    if (permission !== 'granted') throw new MemoryMountError('PERMISSION_REQUIRED');
    this.revoke(agentId);
  }

  async resolve(agentId: string): Promise<ResolvedMemory> {
    const authorityEpoch = this.captureAuthorityEpoch(agentId);
    let binding;
    try {
      binding = await this.repository.get(agentId);
    } catch {
      if (!this.revokeIfCurrent(agentId, authorityEpoch)) return this.bindingChanged();
      const error = new MemoryMountError('BINDING_STORAGE_UNAVAILABLE');
      return {
        state: 'unavailable',
        reason: 'binding-storage-unavailable',
        error,
      };
    }
    if (!binding) {
      if (!this.isAuthorityEpochCurrent(agentId, authorityEpoch)) return this.bindingChanged();
      // A missing row must invalidate a lease or an in-flight bound resolution,
      // but concurrent reads of a never-mounted agent must remain stateless.
      if (this.leases.has(agentId) || (this.resolvingBindings.get(agentId) ?? 0) > 0) {
        this.revoke(agentId);
      }
      return { state: 'unmounted' };
    }

    this.beginBoundResolution(agentId);
    try {
      if (!this.isAuthorityEpochCurrent(agentId, authorityEpoch)) {
        return this.bindingChanged();
      }

      const rootName = binding.handle.name;
      if ((await queryReadWritePermission(binding.handle)) !== 'granted') {
        if (!this.revokeIfCurrent(agentId, authorityEpoch)) return this.bindingChanged(rootName);
        const error = new MemoryMountError('PERMISSION_REQUIRED');
        return { state: 'unavailable', rootName, reason: 'permission-required', error };
      }

      const filesystem = new MemoryFilesystem(binding.handle);
      try {
        await filesystem.validateLayout();
        const memoryFile = await filesystem.readMemory();
        const authoritySignal = await this.authoritySignal(agentId, binding.handle, authorityEpoch);
        if (!authoritySignal) return this.bindingChanged(rootName);
        return {
          state: 'available',
          rootName,
          filesystem,
          authoritySignal,
          ...(memoryFile && { memoryFile }),
        };
      } catch (failure) {
        if (!this.revokeIfCurrent(agentId, authorityEpoch)) return this.bindingChanged(rootName);
        const error = mapFilesystemFailure(failure);
        const reason: MemoryUnavailableReason =
          error.code === 'INCOMPATIBLE_LAYOUT'
            ? 'incompatible-layout'
            : error.code === 'MEMORY_TOO_LARGE'
              ? 'memory-too-large'
              : 'root-unavailable';
        return { state: 'unavailable', rootName, reason, error };
      }
    } finally {
      this.endBoundResolution(agentId);
    }
  }

  async pruneBindings(validAgentIds: ReadonlySet<string>): Promise<void> {
    try {
      await runMemoryMutation(async () => {
        for (const binding of await this.repository.list()) {
          if (!validAgentIds.has(binding.agentId)) {
            await this.repository.delete(binding.agentId);
            this.revoke(binding.agentId);
          }
        }
      });
    } catch {
      throw new MemoryMountError('BINDING_STORAGE_UNAVAILABLE');
    }
  }

  revokeAll(): void {
    this.globalAuthorityEpoch++;
    for (const agentId of [...this.leases.keys()]) this.retireLease(agentId);
  }

  /** Revoke every captured closure for an agent without touching the user’s files. */
  revoke(agentId: string): void {
    this.agentAuthorityEpochs.set(agentId, (this.agentAuthorityEpochs.get(agentId) ?? 0) + 1);
    this.retireLease(agentId);
  }

  private beginBoundResolution(agentId: string): void {
    this.resolvingBindings.set(agentId, (this.resolvingBindings.get(agentId) ?? 0) + 1);
  }

  private endBoundResolution(agentId: string): void {
    const remaining = (this.resolvingBindings.get(agentId) ?? 1) - 1;
    if (remaining === 0) this.resolvingBindings.delete(agentId);
    else this.resolvingBindings.set(agentId, remaining);
  }

  private captureAuthorityEpoch(agentId: string): readonly [number, number] {
    return [this.globalAuthorityEpoch, this.agentAuthorityEpochs.get(agentId) ?? 0];
  }

  private isAuthorityEpochCurrent(
    agentId: string,
    [globalEpoch, agentEpoch]: readonly [number, number]
  ): boolean {
    return (
      globalEpoch === this.globalAuthorityEpoch &&
      agentEpoch === (this.agentAuthorityEpochs.get(agentId) ?? 0)
    );
  }

  private revokeIfCurrent(agentId: string, authorityEpoch: readonly [number, number]): boolean {
    if (!this.isAuthorityEpochCurrent(agentId, authorityEpoch)) return false;
    this.revoke(agentId);
    return true;
  }

  private retireLease(agentId: string): void {
    const lease = this.leases.get(agentId);
    if (!lease) return;
    this.leases.delete(agentId);
    lease.controller.abort();
  }

  private bindingChanged(rootName?: string): ResolvedMemory {
    const error = new MemoryMountError('BINDING_CHANGED');
    return { state: 'unavailable', rootName, reason: 'binding-changed', error };
  }

  // Recheck the captured epoch after every identity await. Do not insert an await
  // between that check and replacing a lease: stale work must not retire newer authority.
  private async authoritySignal(
    agentId: string,
    handle: MemoryDirectoryHandle,
    authorityEpoch: readonly [number, number]
  ): Promise<AbortSignal | undefined> {
    if (!this.isAuthorityEpochCurrent(agentId, authorityEpoch)) return undefined;
    const existing = this.leases.get(agentId);
    if (existing && !existing.controller.signal.aborted) {
      let sameEntry = false;
      try {
        sameEntry = await existing.handle.isSameEntry(handle);
      } catch {
        // A handle that can no longer prove identity cannot retain authority.
      }
      if (!this.isAuthorityEpochCurrent(agentId, authorityEpoch)) return undefined;
      if (sameEntry) return existing.controller.signal;
      this.retireLease(agentId);
    }

    const controller = new AbortController();
    this.leases.set(agentId, { handle, controller });
    return controller.signal;
  }
}

let memoryManager: MemoryManager | undefined;

export function getMemoryManager(): MemoryManager {
  memoryManager ??= new MemoryManager();
  return memoryManager;
}
