import { describe, expect, it, vi } from 'vitest';
import { MAX_AUTOLOADED_MEMORY_BYTES } from '../src/lib/memory/filesystem';
import { MemoryManager } from '../src/lib/memory/manager';
import { FakeMemoryDirectoryHandle, InMemoryBindingRepository } from './helpers/memory-handles';

function createGate() {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { markStarted, release, started, wait };
}

function stallRepositoryGet(
  repository: InMemoryBindingRepository,
  shouldStall: (agentId: string) => boolean = () => true
) {
  const gate = createGate();
  const originalGet = repository.get.bind(repository);
  repository.get = async (agentId) => {
    const binding = await originalGet(agentId);
    if (shouldStall(agentId)) {
      gate.markStarted();
      await gate.wait;
    }
    return binding;
  };
  return gate;
}

describe('MemoryManager', () => {
  it('keeps unmounted agents stateless and mounts roots independently', async () => {
    const repository = new InMemoryBindingRepository();
    const manager = new MemoryManager(repository);
    const alpha = new FakeMemoryDirectoryHandle('alpha');
    const beta = new FakeMemoryDirectoryHandle('beta');

    await expect(manager.resolve('alpha-agent')).resolves.toEqual({ state: 'unmounted' });
    await manager.connect('alpha-agent', alpha);
    await manager.connect('beta-agent', beta);

    const alphaMemory = await manager.resolve('alpha-agent');
    const betaMemory = await manager.resolve('beta-agent');
    expect(alphaMemory).toMatchObject({ state: 'available', rootName: 'alpha' });
    expect(betaMemory).toMatchObject({ state: 'available', rootName: 'beta' });
    if (alphaMemory.state !== 'available' || betaMemory.state !== 'available') {
      throw new Error('Expected available memory');
    }

    await alphaMemory.filesystem.writeFile('memory/alpha.md', 'alpha only');
    await expect(betaMemory.filesystem.readFile('memory/alpha.md')).rejects.toMatchObject({
      code: 'PATH_NOT_FOUND',
    });
  });

  it('keeps concurrent resolutions of a never-mounted agent stateless', async () => {
    const repository = new InMemoryBindingRepository();
    const manager = new MemoryManager(repository);
    const readsGate = createGate();
    const originalGet = repository.get.bind(repository);
    let reads = 0;
    repository.get = async (agentId) => {
      const binding = await originalGet(agentId);
      if (++reads === 2) readsGate.markStarted();
      await readsGate.wait;
      return binding;
    };

    const first = manager.resolve('stateless-agent');
    const second = manager.resolve('stateless-agent');
    await readsGate.started;
    readsGate.release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { state: 'unmounted' },
      { state: 'unmounted' },
    ]);
  });

  it('invalidates a bound resolution when its row disappears without notification', async () => {
    const repository = new InMemoryBindingRepository();
    const manager = new MemoryManager(repository);
    const root = new FakeMemoryDirectoryHandle('removed-out-of-band');
    await manager.connect('agent', root);
    const permissionGate = createGate();
    vi.spyOn(root, 'queryPermission').mockImplementation(async () => {
      permissionGate.markStarted();
      await permissionGate.wait;
      return 'granted';
    });

    const boundResolution = manager.resolve('agent');
    await permissionGate.started;
    await repository.delete('agent');
    await expect(manager.resolve('agent')).resolves.toEqual({ state: 'unmounted' });
    permissionGate.release();

    await expect(boundResolution).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'binding-changed',
    });
  });

  it('shares one exact workspace while keeping each agent lease independent', async () => {
    const manager = new MemoryManager(new InMemoryBindingRepository());
    const root = new FakeMemoryDirectoryHandle('shared');

    await manager.connect('first-agent', root);
    await manager.connect('second-agent', root);
    const first = await manager.resolve('first-agent');
    const second = await manager.resolve('second-agent');
    if (first.state !== 'available' || second.state !== 'available') {
      throw new Error('Expected shared workspace to be available');
    }

    await first.filesystem.writeFile('memory/shared.md', 'visible to both agents');
    await expect(second.filesystem.readFile('memory/shared.md')).resolves.toMatchObject({
      content: 'visible to both agents',
    });
    expect(first.authoritySignal).not.toBe(second.authoritySignal);

    manager.revoke('first-agent');
    expect(first.authoritySignal.aborted).toBe(true);
    expect(second.authoritySignal.aborted).toBe(false);
    await manager.disconnect('first-agent');
    await expect(manager.resolve('first-agent')).resolves.toEqual({ state: 'unmounted' });
    await expect(manager.resolve('second-agent')).resolves.toMatchObject({
      state: 'available',
      rootName: 'shared',
    });
  });

  it('recognizes a shared root from empty resolve paths when direct identity is unavailable', async () => {
    const manager = new MemoryManager(new InMemoryBindingRepository());
    const root = new FakeMemoryDirectoryHandle('shared');
    await manager.connect('first-agent', root);
    vi.spyOn(root, 'isSameEntry').mockRejectedValue(new DOMException('unavailable'));

    await expect(manager.connect('second-agent', root)).resolves.toBeUndefined();
    await expect(manager.resolve('second-agent')).resolves.toMatchObject({
      state: 'available',
      rootName: 'shared',
    });
  });

  it('rejects parent and descendant roots in either connection order', async () => {
    const parentFirstManager = new MemoryManager(new InMemoryBindingRepository());
    const parentFirst = new FakeMemoryDirectoryHandle('parent-first');
    const nestedSecond = await parentFirst.getDirectoryHandle('nested', { create: true });
    await parentFirstManager.connect('parent-agent', parentFirst);
    await expect(parentFirstManager.connect('nested-agent', nestedSecond)).rejects.toMatchObject({
      code: 'NESTED_ROOT',
    });

    const childFirstManager = new MemoryManager(new InMemoryBindingRepository());
    const parentSecond = new FakeMemoryDirectoryHandle('parent-second');
    const nestedFirst = await parentSecond.getDirectoryHandle('nested', { create: true });
    await childFirstManager.connect('nested-agent', nestedFirst);
    await expect(childFirstManager.connect('parent-agent', parentSecond)).rejects.toMatchObject({
      code: 'NESTED_ROOT',
    });
  });

  it('does not mint authority when a binding is revoked during resolution', async () => {
    const repository = new InMemoryBindingRepository();
    const manager = new MemoryManager(repository);
    const root = new FakeMemoryDirectoryHandle('revocation-race');
    await manager.connect('agent', root);

    const getGate = stallRepositoryGet(repository);

    const resolution = manager.resolve('agent');
    await getGate.started;
    await manager.disconnect('agent');
    getGate.release();

    await expect(resolution).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'binding-changed',
      error: { code: 'BINDING_CHANGED' },
    });
    await expect(manager.resolve('agent')).resolves.toEqual({ state: 'unmounted' });
  });

  it('does not invalidate one agent’s resolution when another agent is revoked', async () => {
    const repository = new InMemoryBindingRepository();
    const manager = new MemoryManager(repository);
    await manager.connect('alpha', new FakeMemoryDirectoryHandle('alpha-root'));
    await manager.connect('beta', new FakeMemoryDirectoryHandle('beta-root'));

    const getGate = stallRepositoryGet(repository, (agentId) => agentId === 'alpha');

    const resolution = manager.resolve('alpha');
    await getGate.started;
    manager.revoke('beta');
    getGate.release();

    await expect(resolution).resolves.toMatchObject({
      state: 'available',
      rootName: 'alpha-root',
    });
  });

  it('invalidates an in-flight resolution when all authority is revoked', async () => {
    const repository = new InMemoryBindingRepository();
    const manager = new MemoryManager(repository);
    await manager.connect('agent', new FakeMemoryDirectoryHandle('root'));

    const getGate = stallRepositoryGet(repository);

    const resolution = manager.resolve('agent');
    await getGate.started;
    manager.revokeAll();
    getGate.release();

    await expect(resolution).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'binding-changed',
      error: { code: 'BINDING_CHANGED' },
    });
  });

  it('does not let a stale resolution retire a newer valid lease', async () => {
    const manager = new MemoryManager(new InMemoryBindingRepository());
    const oldRoot = new FakeMemoryDirectoryHandle('old-root');
    const newRoot = new FakeMemoryDirectoryHandle('new-root');
    await manager.connect('agent', oldRoot);

    const permissionGate = createGate();
    vi.spyOn(oldRoot, 'queryPermission').mockImplementation(async () => {
      permissionGate.markStarted();
      await permissionGate.wait;
      return 'granted';
    });

    const staleResolution = manager.resolve('agent');
    await permissionGate.started;
    await manager.connect('agent', newRoot);
    const freshResolution = await manager.resolve('agent');
    if (freshResolution.state !== 'available') throw new Error('Expected fresh memory');
    permissionGate.release();

    await expect(staleResolution).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'binding-changed',
    });
    expect(freshResolution.authoritySignal.aborted).toBe(false);
  });

  it('does not let a stale permission failure revoke a newer valid lease', async () => {
    const manager = new MemoryManager(new InMemoryBindingRepository());
    const oldRoot = new FakeMemoryDirectoryHandle('old-root');
    const newRoot = new FakeMemoryDirectoryHandle('new-root');
    await manager.connect('agent', oldRoot);

    const permissionGate = createGate();
    vi.spyOn(oldRoot, 'queryPermission').mockImplementation(async () => {
      permissionGate.markStarted();
      await permissionGate.wait;
      return 'prompt';
    });

    const staleResolution = manager.resolve('agent');
    await permissionGate.started;
    await manager.connect('agent', newRoot);
    const freshResolution = await manager.resolve('agent');
    if (freshResolution.state !== 'available') throw new Error('Expected fresh memory');
    permissionGate.release();

    await expect(staleResolution).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'binding-changed',
    });
    expect(freshResolution.authoritySignal.aborted).toBe(false);
  });

  it('loads external MEMORY.md edits fresh for every resolution', async () => {
    const manager = new MemoryManager(new InMemoryBindingRepository());
    const root = new FakeMemoryDirectoryHandle('live-root');
    await root.writeExternal('MEMORY.md', '# First\n');
    await manager.connect('agent', root);

    expect(await manager.resolve('agent')).toMatchObject({
      state: 'available',
      memoryFile: { content: '# First\n' },
    });
    await root.writeExternal('MEMORY.md', '# Externally edited\n');
    expect(await manager.resolve('agent')).toMatchObject({
      state: 'available',
      memoryFile: { content: '# Externally edited\n' },
    });
  });

  it('blocks mounted agents when permission is unavailable', async () => {
    const manager = new MemoryManager(new InMemoryBindingRepository());
    const root = new FakeMemoryDirectoryHandle('revoked-root');
    await manager.connect('agent', root);
    root.setPermission('prompt');

    await expect(manager.resolve('agent')).resolves.toMatchObject({
      state: 'unavailable',
      rootName: 'revoked-root',
      reason: 'permission-required',
      error: { code: 'PERMISSION_REQUIRED' },
    });
  });

  it('renews a persisted handle permission without selecting the folder again', async () => {
    const manager = new MemoryManager(new InMemoryBindingRepository());
    const root = new FakeMemoryDirectoryHandle('renewed-root');
    await manager.connect('agent', root);
    root.setPermission('prompt');
    root.setRequestedPermission('granted');

    await manager.renewPermission('agent');

    await expect(manager.resolve('agent')).resolves.toMatchObject({
      state: 'available',
      rootName: 'renewed-root',
    });
  });

  it('rejects incompatible reserved entries and oversized MEMORY.md', async () => {
    const manager = new MemoryManager(new InMemoryBindingRepository());
    const collision = new FakeMemoryDirectoryHandle('collision');
    await collision.writeExternal('memory', 'not a directory');
    await expect(manager.connect('collision-agent', collision)).rejects.toMatchObject({
      code: 'INCOMPATIBLE_LAYOUT',
    });

    const oversized = new FakeMemoryDirectoryHandle('oversized');
    await oversized.writeExternal('MEMORY.md', 'x'.repeat(MAX_AUTOLOADED_MEMORY_BYTES + 1));
    await manager.connect('oversized-agent', oversized);
    await expect(manager.resolve('oversized-agent')).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'memory-too-large',
      error: { code: 'MEMORY_TOO_LARGE' },
    });
  });

  it('distinguishes missing entries from invalid layouts and deleted roots', async () => {
    const manager = new MemoryManager(new InMemoryBindingRepository());
    const invalidText = new FakeMemoryDirectoryHandle('invalid-text');
    await invalidText.writeExternal('MEMORY.md', new Uint8Array([0xff]));
    await manager.connect('invalid-text-agent', invalidText);
    await expect(manager.resolve('invalid-text-agent')).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'incompatible-layout',
      error: { code: 'INCOMPATIBLE_LAYOUT' },
    });

    const missingDirectory = new FakeMemoryDirectoryHandle('missing-directory');
    await manager.connect('missing-directory-agent', missingDirectory);
    await missingDirectory.removeEntry('memory', { recursive: true });
    await expect(manager.resolve('missing-directory-agent')).resolves.toMatchObject({
      state: 'available',
      rootName: 'missing-directory',
    });

    const changedLayout = new FakeMemoryDirectoryHandle('changed-layout');
    await manager.connect('changed-layout-agent', changedLayout);
    await changedLayout.removeEntry('memory', { recursive: true });
    await changedLayout.writeExternal('memory', 'not a directory');
    await expect(manager.resolve('changed-layout-agent')).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'incompatible-layout',
      error: { code: 'INCOMPATIBLE_LAYOUT' },
    });

    const deletedRoot = new FakeMemoryDirectoryHandle('deleted-root');
    await manager.connect('deleted-root-agent', deletedRoot);
    vi.spyOn(deletedRoot, 'getDirectoryHandle').mockRejectedValue(
      new DOMException('deleted', 'NotFoundError')
    );
    vi.spyOn(deletedRoot, 'entries').mockReturnValue({
      next: () => Promise.reject(new DOMException('deleted', 'NotFoundError')),
      [Symbol.asyncIterator]() {
        return this;
      },
    });
    await expect(manager.resolve('deleted-root-agent')).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'root-unavailable',
      error: { code: 'ROOT_UNAVAILABLE' },
    });
  });

  it('disconnects and prunes capabilities without deleting user files', async () => {
    const repository = new InMemoryBindingRepository();
    const manager = new MemoryManager(repository);
    const keep = new FakeMemoryDirectoryHandle('keep');
    const remove = new FakeMemoryDirectoryHandle('remove');
    await manager.connect('keep-agent', keep);
    await manager.connect('remove-agent', remove);
    const removeMemory = await manager.resolve('remove-agent');
    if (removeMemory.state !== 'available') throw new Error('Expected available memory');
    await removeMemory.filesystem.writeFile('memory/preserved.md', 'still on disk');

    await manager.pruneBindings(new Set(['keep-agent']));
    await expect(manager.resolve('remove-agent')).resolves.toEqual({ state: 'unmounted' });
    const memoryDirectory = await remove.getDirectoryHandle('memory');
    expect((await memoryDirectory.getFileHandle('preserved.md')).kind).toBe('file');

    await manager.disconnect('keep-agent');
    await expect(manager.resolve('keep-agent')).resolves.toEqual({ state: 'unmounted' });
    expect((await keep.getFileHandle('MEMORY.md')).kind).toBe('file');
  });
});
