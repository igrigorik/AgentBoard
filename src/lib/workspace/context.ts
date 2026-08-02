import {
  MAX_AUTOLOADED_MEMORY_BYTES,
  MemoryFileError,
  type MemoryFilesystem,
} from '../memory/filesystem';

export const MAX_WORKSPACE_BOOTSTRAP_BYTES = 128 * 1024;

export const WORKSPACE_STANDING_FILES = [
  ['identity', 'IDENTITY.md'],
  ['soul', 'SOUL.md'],
  ['user', 'USER.md'],
  ['agents', 'AGENTS.md'],
] as const;

export interface WorkspaceStandingFiles {
  identity: string | null;
  soul: string | null;
  user: string | null;
  agents: string | null;
}

export interface WorkspaceBootstrapFiles extends WorkspaceStandingFiles {
  memory: string;
}

export type WorkspaceContextErrorCode = 'MEMORY_TOO_LARGE' | 'WORKSPACE_TOO_LARGE';

/** Distinguishes the existing MEMORY.md cap from the aggregate bootstrap cap. */
export class WorkspaceContextError extends Error {
  constructor(readonly code: WorkspaceContextErrorCode) {
    super(code);
    this.name = 'WorkspaceContextError';
  }
}

/** Read the five fixed root files once; missing standing files are normal. */
export async function loadWorkspaceBootstrap(
  filesystem: MemoryFilesystem
): Promise<WorkspaceBootstrapFiles> {
  const result: WorkspaceBootstrapFiles = {
    identity: null,
    soul: null,
    user: null,
    agents: null,
    memory: '',
  };
  let totalBytes = 0;

  for (const [key, filename] of WORKSPACE_STANDING_FILES) {
    let snapshot;
    try {
      snapshot = await filesystem.readOptionalRootFile(filename, MAX_WORKSPACE_BOOTSTRAP_BYTES);
    } catch (error) {
      if (error instanceof MemoryFileError && error.code === 'FILE_TOO_LARGE') {
        throw new WorkspaceContextError('WORKSPACE_TOO_LARGE');
      }
      throw error;
    }
    if (!snapshot) continue;
    totalBytes += snapshot.bytes;
    if (totalBytes > MAX_WORKSPACE_BOOTSTRAP_BYTES) {
      throw new WorkspaceContextError('WORKSPACE_TOO_LARGE');
    }
    result[key] = snapshot.content;
  }

  let memory;
  try {
    memory = await filesystem.readOptionalRootFile('MEMORY.md', MAX_AUTOLOADED_MEMORY_BYTES);
  } catch (error) {
    if (error instanceof MemoryFileError && error.code === 'FILE_TOO_LARGE') {
      throw new WorkspaceContextError('MEMORY_TOO_LARGE');
    }
    throw error;
  }
  if (memory) {
    totalBytes += memory.bytes;
    if (totalBytes > MAX_WORKSPACE_BOOTSTRAP_BYTES) {
      throw new WorkspaceContextError('WORKSPACE_TOO_LARGE');
    }
    result.memory = memory.content;
  }

  return result;
}
