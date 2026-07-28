import { describe, expect, it, vi } from 'vitest';
import { initializeMemoryRoot, MemoryFilesystem } from '../src/lib/memory/filesystem';
import { MEMORY_TOOL_NAMES } from '../src/lib/memory/tool-names';
import { createMemoryTools } from '../src/lib/memory/tools';
import { FakeMemoryDirectoryHandle } from './helpers/memory-handles';

type ExecutableTool = {
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

    const created = (await write.execute(
      { path: 'memory/durable.md', content: 'durable fact' },
      {}
    )) as { revision: string };
    await expect(list.execute({ path: 'memory', pattern: 'dur*.md' }, {})).resolves.toMatchObject({
      entries: [{ path: 'memory/durable.md', type: 'file' }],
      truncated: false,
    });
    await expect(
      read.execute({ path: 'memory/durable.md', agentId: 'another-agent', root: '/tmp' }, {})
    ).resolves.toMatchObject({ content: 'durable fact' });
    await expect(
      remove.execute({ path: 'memory/durable.md', expectedRevision: created.revision }, {})
    ).resolves.toEqual({ path: 'memory/durable.md', deleted: true });
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
