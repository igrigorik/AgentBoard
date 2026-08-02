import { describe, expect, it } from 'vitest';
import {
  initializeMemoryRoot,
  MAX_AUTOLOADED_MEMORY_BYTES,
  MAX_LIST_ENTRIES,
  MAX_MEMORY_FILE_BYTES,
  MemoryFileError,
  MemoryFilesystem,
} from '../src/lib/memory/filesystem';
import { FakeMemoryDirectoryHandle } from './helpers/memory-handles';

async function expectMemoryError(promise: Promise<unknown>, code: MemoryFileError['code']) {
  await expect(promise).rejects.toMatchObject({ name: 'MemoryFileError', code });
}

async function setupMemory() {
  const root = new FakeMemoryDirectoryHandle('agent-memory');
  await initializeMemoryRoot(root);
  return { root, filesystem: new MemoryFilesystem(root) };
}

describe('MemoryFilesystem', () => {
  it('initializes the memory contract without overwriting existing memory', async () => {
    const root = new FakeMemoryDirectoryHandle('agent-memory');
    await root.writeExternal('MEMORY.md', '# Existing\n');

    await initializeMemoryRoot(root);

    const filesystem = new MemoryFilesystem(root);
    expect((await filesystem.readFile('MEMORY.md')).content).toBe('# Existing\n');
    const rootListing = await filesystem.listFiles();
    expect(rootListing.entries).toEqual([
      { path: 'MEMORY.md', type: 'file' },
      { path: 'memory', type: 'directory' },
    ]);
    expect(await filesystem.listFiles('.')).toEqual(rootListing);
  });

  it('reads the whole root but confines writes to current memory paths', async () => {
    const root = new FakeMemoryDirectoryHandle('agent-memory');
    await root.writeExternal('KNOWLEDGE.md', '# Legacy\n');
    await root.writeExternal('AGENTS.md', 'portable instructions are data');
    await root.createDirectory('notes');
    await initializeMemoryRoot(root);
    const filesystem = new MemoryFilesystem(root);

    expect((await filesystem.readFile('MEMORY.md')).content).toBe('# Memory\n');
    expect((await filesystem.readFile('KNOWLEDGE.md')).content).toBe('# Legacy\n');
    expect((await filesystem.readFile('AGENTS.md')).content).toContain('data');
    for (const protectedPath of [
      'KNOWLEDGE.md',
      'notes/legacy.md',
      'AGENTS.md',
      'SOUL.md',
      'IDENTITY.md',
      'USER.md',
      'other.md',
    ]) {
      await expectMemoryError(
        filesystem.writeFile(protectedPath, 'replacement'),
        'WRITE_NOT_ALLOWED'
      );
    }
  });

  it('rejects invalid paths, patterns, and file/directory type mismatches', async () => {
    const { filesystem } = await setupMemory();

    for (const path of [
      '/memory/a.md',
      '../outside.md',
      'memory//a.md',
      'memory/a.md/',
      'memory\\a.md',
    ]) {
      await expectMemoryError(filesystem.readFile(path), 'INVALID_PATH');
    }
    await expectMemoryError(filesystem.writeFile('memory/a.md/', 'invalid'), 'INVALID_PATH');
    await expectMemoryError(
      filesystem.deleteFile('memory/a.md/', `sha256:${'0'.repeat(64)}`),
      'INVALID_PATH'
    );
    for (const path of ['/memory/', 'memory//', 'memory/./', 'memory/../', './']) {
      await expectMemoryError(filesystem.listFiles(path), 'INVALID_PATH');
    }
    for (const pattern of ['', 'memory/*.md', 'memory\\*.md', '\0', 'x'.repeat(256)]) {
      await expectMemoryError(filesystem.listFiles('memory', pattern), 'INVALID_PATTERN');
    }
    await expectMemoryError(filesystem.listFiles('MEMORY.md'), 'NOT_A_DIRECTORY');
  });

  it('filters immediate entries with case-sensitive basename globs', async () => {
    const { filesystem } = await setupMemory();
    await filesystem.writeFile('memory/2026-07-01.md', 'first');
    await filesystem.writeFile('memory/2026-07-02.md', 'second');
    await filesystem.writeFile('memory/2026-06-30.md', 'previous');
    await filesystem.writeFile('memory/archive/2026-07-03.md', 'nested');
    await filesystem.writeFile('memory/UPPER.MD', 'upper');

    expect(await filesystem.listFiles('memory/')).toEqual(await filesystem.listFiles('memory'));
    await expect(filesystem.listFiles('memory', '2026-07-??.md')).resolves.toMatchObject({
      entries: [
        { path: 'memory/2026-07-01.md', type: 'file' },
        { path: 'memory/2026-07-02.md', type: 'file' },
      ],
      truncated: false,
    });
    const july = await filesystem.listFiles('memory', '*-07-*.md');
    expect(july.entries.map((entry) => entry.path)).toEqual([
      'memory/2026-07-01.md',
      'memory/2026-07-02.md',
    ]);
    const markdown = await filesystem.listFiles('memory', '*.md');
    expect(markdown.entries.map((entry) => entry.path)).toEqual([
      'memory/2026-06-30.md',
      'memory/2026-07-01.md',
      'memory/2026-07-02.md',
    ]);
    await expect(filesystem.listFiles('memory', 'arch*')).resolves.toMatchObject({
      entries: [{ path: 'memory/archive', type: 'directory' }],
    });
  });

  it('requires current revisions and lets external edits win', async () => {
    const { root, filesystem } = await setupMemory();

    const created = await filesystem.writeFile('memory/decision.md', 'version one');
    expect(created.created).toBe(true);
    await expectMemoryError(
      filesystem.writeFile('memory/decision.md', 'blind replacement'),
      'REVISION_REQUIRED'
    );
    await expectMemoryError(
      filesystem.writeFile('memory/missing.md', 'unexpected create', created.revision),
      'REVISION_CONFLICT'
    );

    await root.writeExternal('memory/decision.md', 'external version');
    await expectMemoryError(
      filesystem.writeFile('memory/decision.md', 'version two', created.revision),
      'REVISION_CONFLICT'
    );

    const current = await filesystem.readFile('memory/decision.md');
    const replaced = await filesystem.writeFile(
      'memory/decision.md',
      'version two',
      current.revision
    );
    expect(replaced.created).toBe(false);
    expect((await filesystem.readFile('memory/decision.md')).content).toBe('version two');
  });

  it('rechecks authority immediately before committing writes and deletes', async () => {
    const { filesystem } = await setupMemory();
    const original = await filesystem.writeFile('memory/protected.md', 'original');
    let authorityChecks = 0;

    await expectMemoryError(
      filesystem.writeFile(
        'memory/protected.md',
        'late replacement',
        original.revision,
        () => ++authorityChecks === 1
      ),
      'OPERATION_FAILED'
    );
    const preserved = await filesystem.readFile('memory/protected.md');
    expect(preserved.content).toBe('original');

    await expectMemoryError(
      filesystem.deleteFile('memory/protected.md', preserved.revision, () => false),
      'OPERATION_FAILED'
    );
    await expect(filesystem.readFile('memory/protected.md')).resolves.toMatchObject({
      content: 'original',
      revision: preserved.revision,
    });
  });

  it('deletes only revision-matched files under memory', async () => {
    const { filesystem } = await setupMemory();
    const journal = await filesystem.writeFile('memory/2026-07-25.md', 'forget me');

    await expectMemoryError(
      filesystem.deleteFile('memory/2026-07-25.md', 'sha256:stale'),
      'REVISION_CONFLICT'
    );
    await expectMemoryError(
      filesystem.deleteFile('MEMORY.md', journal.revision),
      'WRITE_NOT_ALLOWED'
    );
    await expect(filesystem.deleteFile('memory/2026-07-25.md', journal.revision)).resolves.toEqual({
      path: 'memory/2026-07-25.md',
      deleted: true,
    });
    await expectMemoryError(filesystem.readFile('memory/2026-07-25.md'), 'PATH_NOT_FOUND');
  });

  it('never treats memory directories as writable or deletable files', async () => {
    const { root, filesystem } = await setupMemory();
    await root.createDirectory('memory/archive');

    await expectMemoryError(filesystem.readFile('memory/archive'), 'NOT_A_FILE');
    await expectMemoryError(filesystem.writeFile('memory/archive', 'replacement'), 'NOT_A_FILE');
    await expectMemoryError(filesystem.deleteFile('memory/archive', 'revision'), 'NOT_A_FILE');
    await expectMemoryError(filesystem.deleteFile('memory', 'revision'), 'WRITE_NOT_ALLOWED');
  });

  it('enforces bounded UTF-8 reads and directory listings', async () => {
    const { root, filesystem } = await setupMemory();
    await root.writeExternal('large.txt', 'x'.repeat(MAX_MEMORY_FILE_BYTES + 1));
    await root.writeExternal('bom.txt', new Uint8Array([0xef, 0xbb, 0xbf, 0x41]));
    await root.writeExternal('binary.txt', new Uint8Array([0xc3, 0x28]));
    const memoryDirectory = await root.getDirectoryHandle('memory');
    for (let index = 0; index <= MAX_LIST_ENTRIES; index++) {
      await memoryDirectory.getFileHandle(`${String(index).padStart(3, '0')}.md`, {
        create: true,
      });
    }

    await expectMemoryError(filesystem.readFile('large.txt'), 'FILE_TOO_LARGE');
    await expectMemoryError(filesystem.readFile('binary.txt'), 'INVALID_TEXT');
    await expect(filesystem.readFile('bom.txt')).resolves.toMatchObject({
      content: '\uFEFFA',
      bytes: 4,
    });
    const listing = await filesystem.listFiles('memory');
    expect(listing.truncated).toBe(true);
    expect(listing.entries).toHaveLength(MAX_LIST_ENTRIES);
    await expect(filesystem.listFiles('memory', '200.md')).resolves.toMatchObject({
      entries: [{ path: 'memory/200.md', type: 'file' }],
      truncated: false,
    });
  });

  it('uses the smaller MEMORY.md bound consistently for reads and writes', async () => {
    const { root, filesystem } = await setupMemory();
    const memoryFile = await filesystem.readFile('MEMORY.md');

    await expectMemoryError(
      filesystem.writeFile(
        'MEMORY.md',
        'x'.repeat(MAX_AUTOLOADED_MEMORY_BYTES + 1),
        memoryFile.revision
      ),
      'FILE_TOO_LARGE'
    );
    await root.writeExternal('MEMORY.md', 'x'.repeat(MAX_AUTOLOADED_MEMORY_BYTES + 1));
    await expectMemoryError(
      filesystem.readOptionalRootFile('MEMORY.md', MAX_AUTOLOADED_MEMORY_BYTES),
      'FILE_TOO_LARGE'
    );
    await expectMemoryError(filesystem.readFile('MEMORY.md'), 'FILE_TOO_LARGE');
  });

  it('treats a missing MEMORY.md as an absent optional root file', async () => {
    const filesystem = new MemoryFilesystem(new FakeMemoryDirectoryHandle('agent-memory'));
    await expect(
      filesystem.readOptionalRootFile('MEMORY.md', MAX_AUTOLOADED_MEMORY_BYTES)
    ).resolves.toBeUndefined();
  });
});
