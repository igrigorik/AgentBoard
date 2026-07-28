import type {
  MemoryDirectoryHandle,
  MemoryFile,
  MemoryFileHandle,
  MemoryWritable,
} from '../../src/lib/memory/filesystem';

function fsError(name: string): DOMException {
  return new DOMException(name, name);
}

class FakeMemoryFileHandle implements MemoryFileHandle {
  readonly kind = 'file' as const;

  constructor(
    readonly name: string,
    private content: string | Uint8Array
  ) {}

  getFile(): Promise<MemoryFile> {
    const bytes =
      typeof this.content === 'string' ? new TextEncoder().encode(this.content) : this.content;
    return Promise.resolve({
      size: bytes.byteLength,
      arrayBuffer: () => {
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        return Promise.resolve(copy.buffer);
      },
    });
  }

  createWritable(): Promise<MemoryWritable> {
    let pending = '';
    return Promise.resolve({
      write: async (data) => {
        pending = data;
      },
      close: async () => {
        this.content = pending;
      },
      abort: async () => undefined,
    });
  }

  replace(content: string | Uint8Array): void {
    this.content = content;
  }
}

export class FakeMemoryDirectoryHandle implements MemoryDirectoryHandle {
  readonly kind = 'directory' as const;
  private readonly children = new Map<string, FakeMemoryDirectoryHandle | FakeMemoryFileHandle>();

  constructor(readonly name: string) {}

  async getDirectoryHandle(
    name: string,
    options: { create?: boolean } = {}
  ): Promise<FakeMemoryDirectoryHandle> {
    const child = this.children.get(name);
    if (child?.kind === 'directory') return child;
    if (child) throw fsError('TypeMismatchError');
    if (!options.create) throw fsError('NotFoundError');
    const directory = new FakeMemoryDirectoryHandle(name);
    this.children.set(name, directory);
    return directory;
  }

  async getFileHandle(
    name: string,
    options: { create?: boolean } = {}
  ): Promise<FakeMemoryFileHandle> {
    const child = this.children.get(name);
    if (child?.kind === 'file') return child;
    if (child) throw fsError('TypeMismatchError');
    if (!options.create) throw fsError('NotFoundError');
    const file = new FakeMemoryFileHandle(name, '');
    this.children.set(name, file);
    return file;
  }

  async removeEntry(name: string, options: { recursive?: boolean } = {}): Promise<void> {
    const child = this.children.get(name);
    if (!child) throw fsError('NotFoundError');
    if (child.kind === 'directory' && !options.recursive) {
      if (!(await child.entries().next()).done) throw fsError('InvalidModificationError');
    }
    this.children.delete(name);
  }

  async *entries(): AsyncIterableIterator<
    [string, FakeMemoryDirectoryHandle | FakeMemoryFileHandle]
  > {
    yield* this.children.entries();
  }

  async writeExternal(path: string, content: string | Uint8Array): Promise<void> {
    const segments = path.split('/');
    let directory: FakeMemoryDirectoryHandle = this;
    for (const segment of segments.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }
    const file = await directory.getFileHandle(segments.at(-1)!, { create: true });
    file.replace(content);
  }

  async createDirectory(path: string): Promise<void> {
    let directory: FakeMemoryDirectoryHandle = this;
    for (const segment of path.split('/')) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }
  }
}
