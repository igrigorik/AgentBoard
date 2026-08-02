import { describe, expect, it, vi } from 'vitest';
import { MemoryFileError, MemoryFilesystem } from '../src/lib/memory/filesystem';
import {
  loadWorkspaceBootstrap,
  MAX_WORKSPACE_BOOTSTRAP_BYTES,
  WorkspaceContextError,
} from '../src/lib/workspace/context';
import { FakeMemoryDirectoryHandle } from './helpers/memory-handles';

describe('Local Workspace bootstrap', () => {
  it('reads the five exact root files once in deterministic order', async () => {
    const root = new FakeMemoryDirectoryHandle('workspace');
    await root.writeExternal('IDENTITY.md', 'Researcher');
    await root.writeExternal('SOUL.md', '');
    await root.writeExternal('AGENTS.md', 'Use browser tools');
    await root.writeExternal('MEMORY.md', '# Memory\nStable fact');
    const getFileHandle = vi.spyOn(root, 'getFileHandle');

    await expect(loadWorkspaceBootstrap(new MemoryFilesystem(root))).resolves.toEqual({
      identity: 'Researcher',
      soul: '',
      user: null,
      agents: 'Use browser tools',
      memory: '# Memory\nStable fact',
    });
    expect(getFileHandle.mock.calls.map(([name]) => name)).toEqual([
      'IDENTITY.md',
      'SOUL.md',
      'USER.md',
      'AGENTS.md',
      'MEMORY.md',
    ]);
  });

  it('accepts the aggregate byte limit and rejects one byte over without truncation', async () => {
    const exact = new FakeMemoryDirectoryHandle('exact');
    await exact.writeExternal('IDENTITY.md', 'i'.repeat(64 * 1024));
    await exact.writeExternal('MEMORY.md', 'm'.repeat(64 * 1024));
    const exactResult = await loadWorkspaceBootstrap(new MemoryFilesystem(exact));
    expect(new TextEncoder().encode(exactResult.identity!).byteLength).toBe(64 * 1024);
    expect(new TextEncoder().encode(exactResult.memory).byteLength).toBe(64 * 1024);
    expect(MAX_WORKSPACE_BOOTSTRAP_BYTES).toBe(128 * 1024);

    const over = new FakeMemoryDirectoryHandle('over');
    await over.writeExternal('IDENTITY.md', 'i'.repeat(64 * 1024 + 1));
    await over.writeExternal('MEMORY.md', 'm'.repeat(64 * 1024));
    await expect(loadWorkspaceBootstrap(new MemoryFilesystem(over))).rejects.toEqual(
      new WorkspaceContextError('WORKSPACE_TOO_LARGE')
    );
  });

  it('preserves the separate MEMORY.md auto-load limit', async () => {
    const root = new FakeMemoryDirectoryHandle('oversized-memory');
    await root.writeExternal('MEMORY.md', 'm'.repeat(64 * 1024 + 1));

    await expect(loadWorkspaceBootstrap(new MemoryFilesystem(root))).rejects.toEqual(
      new WorkspaceContextError('MEMORY_TOO_LARGE')
    );
  });

  it('rejects invalid UTF-8 and case-folded recognized filenames', async () => {
    const invalid = new FakeMemoryDirectoryHandle('invalid');
    await invalid.writeExternal('USER.md', new Uint8Array([0xff]));
    await expect(loadWorkspaceBootstrap(new MemoryFilesystem(invalid))).rejects.toMatchObject({
      name: 'MemoryFileError',
      code: 'INVALID_TEXT',
    });

    const folded = new FakeMemoryDirectoryHandle('folded');
    const lowerCaseHandle = await folded.getFileHandle('identity.md', { create: true });
    const originalGetFileHandle = folded.getFileHandle.bind(folded);
    vi.spyOn(folded, 'getFileHandle').mockImplementation((name, options) =>
      name === 'IDENTITY.md'
        ? Promise.resolve(lowerCaseHandle)
        : originalGetFileHandle(name, options)
    );

    await expect(loadWorkspaceBootstrap(new MemoryFilesystem(folded))).rejects.toEqual(
      new MemoryFileError('NAME_MISMATCH')
    );
  });

  it('rejects a recognized standing filename when it is a directory', async () => {
    const root = new FakeMemoryDirectoryHandle('wrong-kind');
    await root.createDirectory('AGENTS.md');

    await expect(loadWorkspaceBootstrap(new MemoryFilesystem(root))).rejects.toMatchObject({
      name: 'MemoryFileError',
      code: 'NOT_A_FILE',
    });
  });

  it('does not discover nested or alternate standing files', async () => {
    const root = new FakeMemoryDirectoryHandle('workspace');
    await root.writeExternal('memory/IDENTITY.md', 'Nested identity');
    await root.writeExternal('identity.md', 'Lower-case identity');
    await root.writeExternal('MEMORY.md', '# Memory');

    await expect(loadWorkspaceBootstrap(new MemoryFilesystem(root))).resolves.toEqual({
      identity: null,
      soul: null,
      user: null,
      agents: null,
      memory: '# Memory',
    });
  });
});
