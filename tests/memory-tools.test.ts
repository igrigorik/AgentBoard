import { describe, expect, it, vi } from 'vitest';
import { initializeMemoryRoot, MemoryFilesystem } from '../src/lib/memory/filesystem';
import { MEMORY_TOOL_NAMES } from '../src/lib/memory/tool-names';
import { createMemoryTools } from '../src/lib/memory/tools';
import { FakeMemoryDirectoryHandle } from './helpers/memory-handles';

type ExecutableTool = {
  description: string;
  execute: (
    input: Record<string, unknown>,
    options: { abortSignal?: AbortSignal }
  ) => Promise<unknown>;
};

function executable(tools: Record<string, unknown>, name: string): ExecutableTool {
  return tools[name] as ExecutableTool;
}

describe('mounted memory tools', () => {
  it('binds generic file tools to the captured root and revision contract', async () => {
    const root = new FakeMemoryDirectoryHandle('private-root');
    await initializeMemoryRoot(root);
    const authority = new AbortController();
    const tools = createMemoryTools(new MemoryFilesystem(root), authority.signal);

    expect(Object.keys(tools)).toEqual(Object.values(MEMORY_TOOL_NAMES));
    const list = executable(tools, MEMORY_TOOL_NAMES.list);
    const write = executable(tools, MEMORY_TOOL_NAMES.write);
    const read = executable(tools, MEMORY_TOOL_NAMES.read);
    const remove = executable(tools, MEMORY_TOOL_NAMES.delete);

    expect(list.description).toContain('Use memory to list the memory directory');
    expect(read.description).toContain('memory/topic.md');
    expect(read.description).toContain('memory/YYYY-MM-DD.md');
    expect(read.description).toContain('retains a single-use revision receipt');
    expect(write.description).toContain('applies its retained revision automatically');
    expect(remove.description).toContain('applies its retained revision automatically');
    expect(write.description).toContain('compact core of stable facts');
    expect(write.description).toContain('useful journal pointers');
    expect(write.description).toContain('journals may be topical or dated');
    await write.execute({ path: 'memory/durable.md', content: 'durable fact' }, {});
    await expect(list.execute({ path: 'memory/', pattern: 'dur*.md' }, {})).resolves.toMatchObject({
      path: 'memory',
      entries: [{ path: 'memory/durable.md', type: 'file' }],
      truncated: false,
    });
    const current = (await read.execute(
      { path: 'memory/durable.md', agentId: 'another-agent', root: '/tmp' },
      {}
    )) as { content: string; revision: string };
    expect(current.content).toBe('durable fact');
    await expect(remove.execute({ path: 'memory/durable.md' }, {})).resolves.toEqual({
      path: 'memory/durable.md',
      deleted: true,
    });
  });

  it('keeps every standing workspace file read-only at the model-tool boundary', async () => {
    const root = new FakeMemoryDirectoryHandle('private-root');
    await initializeMemoryRoot(root);
    const filesystem = new MemoryFilesystem(root);
    const standingFiles = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'AGENTS.md'];

    for (const path of standingFiles) {
      const original = `Original ${path}`;
      await root.writeExternal(path, original);

      const writeTools = createMemoryTools(filesystem, new AbortController().signal);
      await executable(writeTools, MEMORY_TOOL_NAMES.read).execute({ path }, {});
      await expect(
        executable(writeTools, MEMORY_TOOL_NAMES.write).execute(
          { path, content: 'Model replacement' },
          {}
        )
      ).rejects.toMatchObject({ code: 'WRITE_NOT_ALLOWED' });

      const deleteTools = createMemoryTools(filesystem, new AbortController().signal);
      await executable(deleteTools, MEMORY_TOOL_NAMES.read).execute({ path }, {});
      await expect(
        executable(deleteTools, MEMORY_TOOL_NAMES.delete).execute({ path }, {})
      ).rejects.toMatchObject({ code: 'WRITE_NOT_ALLOWED' });
      await expect(filesystem.readFile(path)).resolves.toMatchObject({ content: original });
    }
  });

  it('requires a path-bound, single-use read from the same request before mutation', async () => {
    const root = new FakeMemoryDirectoryHandle('private-root');
    await initializeMemoryRoot(root);
    const filesystem = new MemoryFilesystem(root);
    const tools = createMemoryTools(filesystem, new AbortController().signal);
    const write = executable(tools, MEMORY_TOOL_NAMES.write);
    const read = executable(tools, MEMORY_TOOL_NAMES.read);
    const remove = executable(tools, MEMORY_TOOL_NAMES.delete);

    await write.execute({ path: 'memory/a.md', content: 'same bytes' }, {});
    await write.execute({ path: 'memory/b.md', content: 'same bytes' }, {});

    await expect(remove.execute({ path: 'memory/a.md' }, {})).rejects.toMatchObject({
      code: 'REVISION_REQUIRED',
    });

    await read.execute({ path: 'memory/a.md' }, {});
    await expect(
      write.execute({ path: 'memory/a.md/', content: 'alias' }, {})
    ).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(remove.execute({ path: 'memory/b.md' }, {})).rejects.toMatchObject({
      code: 'REVISION_REQUIRED',
    });
    await expect(filesystem.readFile('memory/b.md')).resolves.toMatchObject({
      content: 'same bytes',
    });

    await expect(
      write.execute({ path: 'memory/a.md', content: 'updated' }, {})
    ).resolves.toMatchObject({ content: 'updated' });
    await expect(remove.execute({ path: 'memory/a.md' }, {})).rejects.toMatchObject({
      code: 'REVISION_REQUIRED',
    });

    const nextRequestTools = createMemoryTools(filesystem, new AbortController().signal);
    await expect(
      executable(nextRequestTools, MEMORY_TOOL_NAMES.delete).execute({ path: 'memory/b.md' }, {})
    ).rejects.toMatchObject({ code: 'REVISION_REQUIRED' });
  });

  it('preserves an external edit that races a fresh read', async () => {
    const root = new FakeMemoryDirectoryHandle('private-root');
    await initializeMemoryRoot(root);
    const filesystem = new MemoryFilesystem(root);
    const tools = createMemoryTools(filesystem, new AbortController().signal);
    const read = executable(tools, MEMORY_TOOL_NAMES.read);
    const write = executable(tools, MEMORY_TOOL_NAMES.write);
    await write.execute({ path: 'memory/race.md', content: 'before' }, {});
    await read.execute({ path: 'memory/race.md' }, {});

    await root.writeExternal('memory/race.md', 'external edit');
    await expect(
      write.execute({ path: 'memory/race.md', content: 'stale rewrite' }, {})
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(
      write.execute({ path: 'memory/race.md', content: 'second stale rewrite' }, {})
    ).rejects.toMatchObject({ code: 'REVISION_REQUIRED' });
    await expect(filesystem.readFile('memory/race.md')).resolves.toMatchObject({
      content: 'external edit',
    });
  });

  it('applies the retained revision without a model-supplied token', async () => {
    const root = new FakeMemoryDirectoryHandle('private-root');
    await initializeMemoryRoot(root);
    const filesystem = new MemoryFilesystem(root);
    const tools = createMemoryTools(filesystem, new AbortController().signal);
    const read = executable(tools, MEMORY_TOOL_NAMES.read);
    const write = executable(tools, MEMORY_TOOL_NAMES.write);

    await read.execute({ path: 'MEMORY.md' }, {});
    await expect(
      write.execute({ path: 'MEMORY.md', content: '# Updated\n' }, {})
    ).resolves.toMatchObject({
      path: 'MEMORY.md',
      content: '# Updated\n',
      created: false,
    });
    await expect(filesystem.readFile('MEMORY.md')).resolves.toMatchObject({
      content: '# Updated\n',
    });
  });

  it('rejects every captured tool closure after its authority is revoked', async () => {
    const root = new FakeMemoryDirectoryHandle('private-root');
    await initializeMemoryRoot(root);
    const authority = new AbortController();
    const tools = createMemoryTools(new MemoryFilesystem(root), authority.signal);
    authority.abort();

    await expect(executable(tools, MEMORY_TOOL_NAMES.list).execute({}, {})).rejects.toMatchObject({
      name: 'MemoryMountError',
      code: 'ROOT_UNAVAILABLE',
    });
    await expect(
      executable(tools, MEMORY_TOOL_NAMES.write).execute(
        { path: 'memory/late.md', content: 'must not be written' },
        {}
      )
    ).rejects.toMatchObject({ name: 'MemoryMountError', code: 'ROOT_UNAVAILABLE' });
    const filesystem = new MemoryFilesystem(root);
    await expect(filesystem.readFile('memory/late.md')).rejects.toMatchObject({
      code: 'PATH_NOT_FOUND',
    });
  });

  it('rejects a tool result when authority is revoked during an operation', async () => {
    let finishList!: () => void;
    const listFinished = new Promise<void>((resolve) => {
      finishList = resolve;
    });
    const filesystem = {
      listFiles: vi.fn(async () => {
        await listFinished;
        return { path: '.', entries: [], truncated: false };
      }),
    } as unknown as MemoryFilesystem;
    const authority = new AbortController();
    const tools = createMemoryTools(filesystem, authority.signal);

    const execution = executable(tools, MEMORY_TOOL_NAMES.list).execute({}, {});
    await vi.waitFor(() => expect(filesystem.listFiles).toHaveBeenCalled());
    authority.abort();
    finishList();

    await expect(execution).rejects.toMatchObject({
      name: 'MemoryMountError',
      code: 'ROOT_UNAVAILABLE',
    });
  });

  it('passes live request authority through an in-flight mutation', async () => {
    const request = new AbortController();
    const filesystem = {
      writeFile: vi.fn(
        async (
          _path: string,
          _content: string,
          _revision: string | undefined,
          isAuthorized: () => boolean
        ) => {
          expect(isAuthorized()).toBe(true);
          request.abort();
          expect(isAuthorized()).toBe(false);
          return { path: 'memory/cancelled.md', content: '', revision: 'sha256:none', bytes: 0 };
        }
      ),
    } as unknown as MemoryFilesystem;
    const tools = createMemoryTools(filesystem, new AbortController().signal);

    await expect(
      executable(tools, MEMORY_TOOL_NAMES.write).execute(
        { path: 'memory/cancelled.md', content: 'must not be committed' },
        { abortSignal: request.signal }
      )
    ).rejects.toMatchObject({ name: 'MemoryMountError', code: 'ROOT_UNAVAILABLE' });
  });

  it('honors the owning AI request abort before local mutation', async () => {
    const root = new FakeMemoryDirectoryHandle('private-root');
    await initializeMemoryRoot(root);
    const tools = createMemoryTools(new MemoryFilesystem(root), new AbortController().signal);
    const request = new AbortController();
    request.abort();

    await expect(
      executable(tools, MEMORY_TOOL_NAMES.write).execute(
        { path: 'memory/cancelled.md', content: 'must not be written' },
        { abortSignal: request.signal }
      )
    ).rejects.toMatchObject({ name: 'MemoryMountError', code: 'ROOT_UNAVAILABLE' });
  });
});
