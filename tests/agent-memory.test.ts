import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryManager } from '../src/lib/memory/manager';
import { AgentMemoryControls } from '../src/options/agent-memory';
import { FakeMemoryDirectoryHandle, InMemoryBindingRepository } from './helpers/memory-handles';

function renderFixture(): void {
  document.body.innerHTML = `
    <fieldset id="agent-memory-section" class="hidden" aria-busy="false">
      <strong id="agent-memory-state"></strong>
      <span id="agent-memory-detail"></span>
      <button id="agent-memory-connect" type="button" disabled></button>
      <button id="agent-memory-disconnect" type="button" class="hidden" disabled></button>
    </fieldset>
  `;
}

function button(id: string): HTMLButtonElement {
  return document.getElementById(id) as HTMLButtonElement;
}

function text(id: string): string {
  return document.getElementById(id)?.textContent ?? '';
}

describe('AgentMemoryControls', () => {
  beforeEach(() => {
    renderFixture();
    vi.mocked(chrome.runtime.sendMessage).mockReset().mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps new agents disconnected until they have a stable ID', async () => {
    const manager = new MemoryManager(new InMemoryBindingRepository());
    const picker = vi.fn();
    const controls = new AgentMemoryControls(document, manager, picker, vi.fn());
    controls.initialize();

    await controls.show(null);

    expect(text('agent-memory-state')).toBe('Not connected');
    expect(text('agent-memory-detail')).toContain('Save this agent');
    expect(button('agent-memory-connect').disabled).toBe(true);
    expect(button('agent-memory-disconnect').classList).toContain('hidden');
  });

  it('invokes the native directory picker with its required global receiver', async () => {
    const manager = new MemoryManager(new InMemoryBindingRepository());
    const root = new FakeMemoryDirectoryHandle('private-folder');
    const picker = vi.fn(function (this: typeof globalThis) {
      expect(this).toBe(globalThis);
      return Promise.resolve(root);
    });
    vi.stubGlobal('showDirectoryPicker', picker);
    const controls = new AgentMemoryControls(
      document,
      manager,
      undefined,
      vi.fn().mockResolvedValue(undefined)
    );
    controls.initialize();
    await controls.show('agent-1');

    button('agent-memory-connect').click();
    await vi.waitFor(() => expect(text('agent-memory-state')).toBe('Connected'));

    expect(picker).toHaveBeenCalledWith({ mode: 'readwrite' });
  });

  it('mounts and initializes a picked folder under the edited agent only', async () => {
    const manager = new MemoryManager(new InMemoryBindingRepository());
    const root = new FakeMemoryDirectoryHandle('private-folder');
    const notify = vi.fn().mockResolvedValue(undefined);
    const controls = new AgentMemoryControls(
      document,
      manager,
      vi.fn().mockResolvedValue(root),
      notify
    );
    controls.initialize();
    await controls.show('agent-1');

    button('agent-memory-connect').click();
    await vi.waitFor(() => expect(text('agent-memory-state')).toBe('Connected'));

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith('agent-1');
    expect(text('agent-memory-detail')).toBe('Folder: private-folder');
    expect(button('agent-memory-connect').textContent).toBe('Change folder');
    await expect(manager.resolve('agent-1')).resolves.toMatchObject({ state: 'available' });
    await expect(manager.resolve('other-agent')).resolves.toEqual({ state: 'unmounted' });
  });

  it('surfaces a nested-root rejection', async () => {
    const manager = new MemoryManager(new InMemoryBindingRepository());
    const parent = new FakeMemoryDirectoryHandle('parent-folder');
    const nested = await parent.getDirectoryHandle('nested', { create: true });
    await manager.connect('first-agent', parent);
    const controls = new AgentMemoryControls(
      document,
      manager,
      vi.fn().mockResolvedValue(nested),
      vi.fn().mockResolvedValue(undefined)
    );
    controls.initialize();
    await controls.show('second-agent');

    button('agent-memory-connect').click();
    await vi.waitFor(() => expect(text('agent-memory-state')).toBe('Connection failed'));

    expect(text('agent-memory-detail')).toContain('parent and child workspaces');
  });

  it('renders permission loss as reconnect-required instead of silently disconnecting', async () => {
    const manager = new MemoryManager(new InMemoryBindingRepository());
    const root = new FakeMemoryDirectoryHandle('revoked-folder');
    await manager.connect('agent-1', root);
    root.setPermission('prompt');
    const controls = new AgentMemoryControls(document, manager, vi.fn(), vi.fn());

    await controls.show('agent-1');

    expect(text('agent-memory-state')).toBe('Reconnect required');
    expect(text('agent-memory-detail')).toContain('Browser permission must be restored');
    expect(button('agent-memory-connect').disabled).toBe(false);
    expect(button('agent-memory-connect').textContent).toBe('Restore folder access');
    expect(button('agent-memory-disconnect').classList).not.toContain('hidden');
  });

  it('requests stored-folder permission synchronously from the click task', async () => {
    const manager = new MemoryManager(new InMemoryBindingRepository());
    const root = new FakeMemoryDirectoryHandle('renewed-folder');
    await manager.connect('agent-1', root);
    root.setPermission('prompt');
    const picker = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    const requestPermission = vi.spyOn(root, 'requestPermission');
    let clickTaskActive = false;
    requestPermission.mockImplementation(() => {
      expect(clickTaskActive).toBe(true);
      root.setPermission('granted');
      return Promise.resolve('granted');
    });
    const controls = new AgentMemoryControls(document, manager, picker, notify);
    controls.initialize();
    await controls.show('agent-1');

    clickTaskActive = true;
    button('agent-memory-connect').click();
    clickTaskActive = false;
    await vi.waitFor(() => expect(text('agent-memory-state')).toBe('Connected'));

    expect(picker).not.toHaveBeenCalled();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission.mock.invocationCallOrder[0]).toBeLessThan(
      notify.mock.invocationCallOrder[0]
    );
    expect(text('agent-memory-detail')).toBe('Folder: renewed-folder');
  });

  it('drops a picked folder when the editor moves to another agent', async () => {
    const manager = new MemoryManager(new InMemoryBindingRepository());
    const root = new FakeMemoryDirectoryHandle('agent-a-folder');
    let releasePicker!: (handle: FakeMemoryDirectoryHandle) => void;
    const pickerResult = new Promise<FakeMemoryDirectoryHandle>((resolve) => {
      releasePicker = resolve;
    });
    const notify = vi.fn().mockResolvedValue(undefined);
    const controls = new AgentMemoryControls(
      document,
      manager,
      vi.fn().mockReturnValue(pickerResult),
      notify
    );
    controls.initialize();
    await controls.show('agent-a');

    button('agent-memory-connect').click();
    expect(document.getElementById('agent-memory-section')?.getAttribute('aria-busy')).toBe('true');
    await controls.show('agent-b');
    releasePicker(root);
    await vi.waitFor(() => expect(button('agent-memory-connect').disabled).toBe(false));

    expect(notify).not.toHaveBeenCalled();
    await expect(manager.resolve('agent-a')).resolves.toEqual({ state: 'unmounted' });
    await expect(manager.resolve('agent-b')).resolves.toEqual({ state: 'unmounted' });
    expect(text('agent-memory-state')).toBe('Not connected');
  });

  it('revokes the worker before disconnecting the selected agent', async () => {
    const manager = new MemoryManager(new InMemoryBindingRepository());
    const root = new FakeMemoryDirectoryHandle('persistent-folder');
    await manager.connect('agent-1', root);
    const notify = vi.fn().mockResolvedValue(undefined);
    const controls = new AgentMemoryControls(document, manager, vi.fn(), notify);

    await controls.removeBinding('agent-1');

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith('agent-1');
    await expect(manager.resolve('agent-1')).resolves.toEqual({ state: 'unmounted' });
  });

  it('does not revoke or mutate a binding when the picker is cancelled', async () => {
    const manager = new MemoryManager(new InMemoryBindingRepository());
    const notify = vi.fn();
    const controls = new AgentMemoryControls(
      document,
      manager,
      vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError')),
      notify
    );
    controls.initialize();
    await controls.show('agent-1');

    button('agent-memory-connect').click();
    await vi.waitFor(() => expect(button('agent-memory-connect').disabled).toBe(false));

    expect(notify).not.toHaveBeenCalled();
    await expect(manager.resolve('agent-1')).resolves.toEqual({ state: 'unmounted' });
  });

  it('fails closed when the worker does not acknowledge a connection change', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({ success: false });
    const manager = new MemoryManager(new InMemoryBindingRepository());
    const root = new FakeMemoryDirectoryHandle('private-folder');
    const controls = new AgentMemoryControls(document, manager, vi.fn().mockResolvedValue(root));
    controls.initialize();
    await controls.show('agent-1');

    button('agent-memory-connect').click();
    await vi.waitFor(() => expect(text('agent-memory-state')).toBe('Connection failed'));

    await expect(manager.resolve('agent-1')).resolves.toEqual({ state: 'unmounted' });
  });

  it('keeps an existing connection when the worker does not acknowledge removal', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({ success: false });
    const manager = new MemoryManager(new InMemoryBindingRepository());
    const root = new FakeMemoryDirectoryHandle('private-folder');
    await manager.connect('agent-1', root);
    const controls = new AgentMemoryControls(document, manager);

    await expect(controls.removeBinding('agent-1')).rejects.toThrow(
      'Failed to revoke the previous memory connection'
    );

    await expect(manager.resolve('agent-1')).resolves.toMatchObject({
      state: 'available',
      rootName: 'private-folder',
    });
  });
});
