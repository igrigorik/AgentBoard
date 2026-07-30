import { createOperationQueue } from '../operation-queue';

export const MEMORY_FILE = 'MEMORY.md';
export const MEMORY_DIRECTORY = 'memory';
export const MAX_MEMORY_FILE_BYTES = 256 * 1024;
export const MAX_AUTOLOADED_MEMORY_BYTES = 64 * 1024;
export const MAX_LIST_ENTRIES = 200;
export const MAX_LIST_PATTERN_LENGTH = 255;

export type MemoryPermissionMode = 'read' | 'readwrite';

export interface MemoryFile {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface MemoryWritable {
  write(data: string): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface MemoryFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<MemoryFile>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<MemoryWritable>;
}

export interface MemoryDirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<[string, MemoryDirectoryHandle | MemoryFileHandle]>;
  isSameEntry(other: MemoryDirectoryHandle): Promise<boolean>;
  resolve(possibleDescendant: MemoryDirectoryHandle): Promise<string[] | null>;
  queryPermission(options?: { mode?: MemoryPermissionMode }): Promise<PermissionState>;
  requestPermission(options?: { mode?: MemoryPermissionMode }): Promise<PermissionState>;
}

export type MemoryFileErrorCode =
  | 'INVALID_PATH'
  | 'INVALID_PATTERN'
  | 'PATH_NOT_FOUND'
  | 'NOT_A_FILE'
  | 'NOT_A_DIRECTORY'
  | 'FILE_TOO_LARGE'
  | 'INVALID_TEXT'
  | 'WRITE_NOT_ALLOWED'
  | 'REVISION_REQUIRED'
  | 'REVISION_CONFLICT'
  | 'OPERATION_FAILED';

/** Stable, provider-visible failures that never expose arbitrary filesystem errors. */
export class MemoryFileError extends Error {
  constructor(readonly code: MemoryFileErrorCode) {
    super(memoryFileErrorMessage(code));
    this.name = 'MemoryFileError';
  }
}

function memoryFileErrorMessage(code: MemoryFileErrorCode): string {
  switch (code) {
    case 'INVALID_PATH':
      return 'Invalid memory path. Use a root-relative path without empty, dot, or parent segments.';
    case 'INVALID_PATTERN':
      return 'Invalid file-list pattern. Use a basename glob with literal characters, * and ?, without path separators.';
    case 'PATH_NOT_FOUND':
      return 'The requested memory path does not exist.';
    case 'NOT_A_FILE':
      return 'The requested memory path is not a file.';
    case 'NOT_A_DIRECTORY':
      return 'The requested memory path is not a directory.';
    case 'FILE_TOO_LARGE':
      return 'The memory file exceeds AgentBoard’s size limit.';
    case 'INVALID_TEXT':
      return 'The memory file is not valid UTF-8 text.';
    case 'WRITE_NOT_ALLOWED':
      return 'Memory writes are limited to MEMORY.md and files under memory/.';
    case 'REVISION_REQUIRED':
      return 'The existing memory file must be read before it can be changed.';
    case 'REVISION_CONFLICT':
      return 'The memory file changed since it was read. Read it again before retrying.';
    default:
      return 'The memory filesystem operation failed.';
  }
}

export interface MemoryFileSnapshot {
  path: string;
  content: string;
  revision: string;
  bytes: number;
}

export interface MemoryListEntry {
  path: string;
  type: 'file' | 'directory';
}

export interface MemoryListResult {
  path: string;
  entries: MemoryListEntry[];
  truncated: boolean;
}

// Keep this lock distinct from storage operations: settings import holds the
// storage lock while asking the worker to clear memory bindings.
export const MEMORY_MUTATION_LOCK = 'agentboard-memory-mutation';
export const runMemoryMutation = createOperationQueue(MEMORY_MUTATION_LOCK);

function nativeErrorName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name)
    : undefined;
}

function isMissingEntry(error: unknown): boolean {
  return nativeErrorName(error) === 'NotFoundError';
}

function isTypeMismatch(error: unknown): boolean {
  return nativeErrorName(error) === 'TypeMismatchError';
}

function parsePath(path: string, allowRoot: boolean): string[] {
  if (typeof path !== 'string' || path.includes('\0') || path.includes('\\')) {
    throw new MemoryFileError('INVALID_PATH');
  }
  if (allowRoot && (path === '' || path === '.')) return [];
  if (!path || path.startsWith('/') || path.length > 512) {
    throw new MemoryFileError('INVALID_PATH');
  }

  const segments = path.split('/');
  if (
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..' || segment.length > 255
    )
  ) {
    throw new MemoryFileError('INVALID_PATH');
  }
  return segments;
}

function validatePattern(pattern: string | undefined): string | undefined {
  if (pattern === undefined) return undefined;
  if (
    typeof pattern !== 'string' ||
    pattern.length === 0 ||
    pattern.length > MAX_LIST_PATTERN_LENGTH ||
    pattern.includes('\0') ||
    pattern.includes('/') ||
    pattern.includes('\\')
  ) {
    throw new MemoryFileError('INVALID_PATTERN');
  }
  return pattern;
}

// Keep filtering predictable and ReDoS-free: only basename literals, * and ? are special.
function matchesPattern(name: string, pattern: string): boolean {
  const nameCharacters = [...name];
  const patternCharacters = [...pattern];
  let nameIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let starMatchIndex = 0;

  while (nameIndex < nameCharacters.length) {
    const token = patternCharacters[patternIndex];
    if (token === '?' || token === nameCharacters[nameIndex]) {
      nameIndex++;
      patternIndex++;
    } else if (token === '*') {
      starIndex = patternIndex++;
      starMatchIndex = nameIndex;
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      nameIndex = ++starMatchIndex;
    } else {
      return false;
    }
  }

  while (patternCharacters[patternIndex] === '*') patternIndex++;
  return patternIndex === patternCharacters.length;
}

function canonicalPath(segments: string[]): string {
  return segments.length === 0 ? '.' : segments.join('/');
}

function finalSegment(segments: string[]): string {
  const segment = segments[segments.length - 1];
  if (!segment) throw new MemoryFileError('INVALID_PATH');
  return segment;
}

function canWrite(path: string): boolean {
  return path === MEMORY_FILE || path.startsWith(`${MEMORY_DIRECTORY}/`);
}

function canDelete(path: string): boolean {
  return path.startsWith(`${MEMORY_DIRECTORY}/`);
}

function maxFileBytes(path: string): number {
  return path === MEMORY_FILE ? MAX_AUTOLOADED_MEMORY_BYTES : MAX_MEMORY_FILE_BYTES;
}

async function getDirectory(
  root: MemoryDirectoryHandle,
  segments: string[],
  create = false
): Promise<MemoryDirectoryHandle> {
  let directory = root;
  try {
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create });
    }
    return directory;
  } catch (error) {
    if (isMissingEntry(error)) throw new MemoryFileError('PATH_NOT_FOUND');
    if (isTypeMismatch(error)) throw new MemoryFileError('NOT_A_DIRECTORY');
    throw new MemoryFileError('OPERATION_FAILED');
  }
}

async function getFileHandle(
  root: MemoryDirectoryHandle,
  segments: string[],
  create = false
): Promise<MemoryFileHandle> {
  const parent = await getDirectory(root, segments.slice(0, -1), create);
  try {
    return await parent.getFileHandle(finalSegment(segments), { create });
  } catch (error) {
    if (isMissingEntry(error)) throw new MemoryFileError('PATH_NOT_FOUND');
    if (isTypeMismatch(error)) throw new MemoryFileError('NOT_A_FILE');
    throw new MemoryFileError('OPERATION_FAILED');
  }
}

async function digest(bytes: ArrayBuffer): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`;
}

async function readHandle(
  handle: MemoryFileHandle,
  path: string,
  maxBytes: number
): Promise<MemoryFileSnapshot> {
  let file: MemoryFile;
  try {
    file = await handle.getFile();
  } catch {
    throw new MemoryFileError('OPERATION_FAILED');
  }
  if (file.size > maxBytes) throw new MemoryFileError('FILE_TOO_LARGE');

  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    throw new MemoryFileError('OPERATION_FAILED');
  }

  let content: string;
  try {
    // Preserve a leading UTF-8 BOM as content so MIME length and rewrites stay byte-faithful.
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new MemoryFileError('INVALID_TEXT');
  }

  return { path, content, revision: await digest(bytes), bytes: bytes.byteLength };
}

async function writeHandle(
  handle: MemoryFileHandle,
  content: string,
  isAuthorized: () => boolean = () => true
): Promise<void> {
  let writable: MemoryWritable | undefined;
  try {
    writable = await handle.createWritable({ keepExistingData: false });
    await writable.write(content);
    if (!isAuthorized()) throw new MemoryFileError('OPERATION_FAILED');
    await writable.close();
  } catch {
    try {
      await writable?.abort?.();
    } catch {
      // The stable operation error below owns the provider-visible failure.
    }
    throw new MemoryFileError('OPERATION_FAILED');
  }
}

export async function initializeMemoryRoot(root: MemoryDirectoryHandle): Promise<void> {
  // The binding manager serializes initialization and binding publication under
  // runMemoryMutation; taking the same non-reentrant lock here would deadlock.
  await getDirectory(root, [MEMORY_DIRECTORY], true);
  try {
    await getFileHandle(root, [MEMORY_FILE]);
  } catch (error) {
    if (!(error instanceof MemoryFileError) || error.code !== 'PATH_NOT_FOUND') throw error;
    const handle = await getFileHandle(root, [MEMORY_FILE], true);
    await writeHandle(handle, '# Memory\n');
  }
}

export class MemoryFilesystem {
  constructor(readonly root: MemoryDirectoryHandle) {}

  async listFiles(path = '.', pattern?: string): Promise<MemoryListResult> {
    const segments = parsePath(path, true);
    const basenamePattern = validatePattern(pattern);
    const directory = await getDirectory(this.root, segments);
    const entries: MemoryListEntry[] = [];
    let truncated = false;

    try {
      for await (const [name, handle] of directory.entries()) {
        if (basenamePattern !== undefined && !matchesPattern(name, basenamePattern)) continue;
        if (entries.length === MAX_LIST_ENTRIES) {
          truncated = true;
          break;
        }
        entries.push({
          path: [...segments, name].join('/'),
          type: handle.kind,
        });
      }
    } catch (error) {
      if (error instanceof MemoryFileError) throw error;
      throw new MemoryFileError('OPERATION_FAILED');
    }

    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { path: canonicalPath(segments), entries, truncated };
  }

  async readFile(path: string): Promise<MemoryFileSnapshot> {
    const segments = parsePath(path, false);
    const normalized = canonicalPath(segments);
    const handle = await getFileHandle(this.root, segments);
    return readHandle(handle, normalized, maxFileBytes(normalized));
  }

  async readMemory(): Promise<MemoryFileSnapshot | undefined> {
    try {
      return await this.readFile(MEMORY_FILE);
    } catch (error) {
      if (error instanceof MemoryFileError && error.code === 'PATH_NOT_FOUND') return undefined;
      throw error;
    }
  }

  async validateLayout(): Promise<void> {
    // Snapshot capture separately validates MEMORY.md; ordinary turns only need a live root.
    try {
      await getDirectory(this.root, [MEMORY_DIRECTORY]);
    } catch (error) {
      if (!(error instanceof MemoryFileError) || error.code !== 'PATH_NOT_FOUND') throw error;
      // A missing optional memory/ entry and a deleted root both surface NotFoundError.
      // Probe the root so a dead mount cannot silently degrade to empty memory.
      try {
        for await (const _entry of this.root.entries()) break;
      } catch {
        throw new MemoryFileError('OPERATION_FAILED');
      }
    }
  }

  async writeFile(
    path: string,
    content: string,
    expectedRevision?: string,
    isAuthorized: () => boolean = () => true
  ): Promise<MemoryFileSnapshot & { created: boolean }> {
    const segments = parsePath(path, false);
    const normalized = canonicalPath(segments);
    if (!canWrite(normalized)) throw new MemoryFileError('WRITE_NOT_ALLOWED');
    const maxBytes = maxFileBytes(normalized);
    const encoded = new TextEncoder().encode(content);
    if (encoded.byteLength > maxBytes) throw new MemoryFileError('FILE_TOO_LARGE');

    return runMemoryMutation(async () => {
      let existing: MemoryFileSnapshot | undefined;
      try {
        const handle = await getFileHandle(this.root, segments);
        existing = await readHandle(handle, normalized, maxBytes);
      } catch (error) {
        if (!(error instanceof MemoryFileError) || error.code !== 'PATH_NOT_FOUND') throw error;
      }

      if (existing) {
        if (expectedRevision === undefined) throw new MemoryFileError('REVISION_REQUIRED');
        if (existing.revision !== expectedRevision) {
          throw new MemoryFileError('REVISION_CONFLICT');
        }
      } else if (expectedRevision !== undefined) {
        throw new MemoryFileError('REVISION_CONFLICT');
      }

      if (!isAuthorized()) throw new MemoryFileError('OPERATION_FAILED');
      const handle = await getFileHandle(this.root, segments, true);
      await writeHandle(handle, content, isAuthorized);
      // Return the bytes actually on disk in case an external editor raced the write.
      return { ...(await readHandle(handle, normalized, maxBytes)), created: !existing };
    });
  }

  async deleteFile(
    path: string,
    expectedRevision: string,
    isAuthorized: () => boolean = () => true
  ): Promise<{ path: string; deleted: true }> {
    const segments = parsePath(path, false);
    const normalized = canonicalPath(segments);
    if (!canDelete(normalized)) throw new MemoryFileError('WRITE_NOT_ALLOWED');

    return runMemoryMutation(async () => {
      const handle = await getFileHandle(this.root, segments);
      const existing = await readHandle(handle, normalized, MAX_MEMORY_FILE_BYTES);
      if (existing.revision !== expectedRevision) {
        throw new MemoryFileError('REVISION_CONFLICT');
      }

      const parent = await getDirectory(this.root, segments.slice(0, -1));
      if (!isAuthorized()) throw new MemoryFileError('OPERATION_FAILED');
      try {
        await parent.removeEntry(finalSegment(segments), { recursive: false });
      } catch {
        throw new MemoryFileError('OPERATION_FAILED');
      }
      return { path: normalized, deleted: true };
    });
  }
}
