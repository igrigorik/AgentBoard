import type { MemoryDirectoryHandle } from '../lib/memory/filesystem';
import {
  getMemoryManager,
  MemoryMountError,
  type MemoryManager,
  type MemoryPermissionRenewal,
} from '../lib/memory/manager';
import type { ExtensionMessage, MessageResponse } from '../types';

type DirectoryPicker = () => Promise<MemoryDirectoryHandle>;
type MemoryManagerFacade = Pick<
  MemoryManager,
  'connect' | 'disconnect' | 'preparePermissionRenewal' | 'resolve'
>;

function requiredElement<T extends HTMLElement>(document: Document, id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing memory control: ${id}`);
  return element as T;
}

async function pickDirectory(): Promise<MemoryDirectoryHandle> {
  const scope = globalThis as typeof globalThis & {
    showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<MemoryDirectoryHandle>;
  };
  if (!scope.showDirectoryPicker) throw new Error('Directory picker unavailable');
  return scope.showDirectoryPicker({ mode: 'readwrite' });
}

async function notifyWorker(agentId: string): Promise<void> {
  const message = { type: 'MEMORY_BINDING_CHANGED', agentId } satisfies ExtensionMessage;
  const response = (await chrome.runtime.sendMessage(message)) as MessageResponse | undefined;
  if (!response?.success) throw new Error('Failed to revoke the previous memory connection');
}

export class AgentMemoryControls {
  private agentId: string | null = null;
  private renderGeneration = 0;
  private permissionRenewal: MemoryPermissionRenewal | null = null;

  private readonly section: HTMLElement;
  private readonly state: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly connectButton: HTMLButtonElement;
  private readonly disconnectButton: HTMLButtonElement;

  constructor(
    document: Document,
    private readonly manager: MemoryManagerFacade = getMemoryManager(),
    private readonly picker: DirectoryPicker = pickDirectory,
    private readonly notify: (agentId: string) => Promise<void> = notifyWorker
  ) {
    this.section = requiredElement(document, 'agent-memory-section');
    this.state = requiredElement(document, 'agent-memory-state');
    this.detail = requiredElement(document, 'agent-memory-detail');
    this.connectButton = requiredElement(document, 'agent-memory-connect');
    this.disconnectButton = requiredElement(document, 'agent-memory-disconnect');
  }

  initialize(): void {
    this.connectButton.addEventListener('click', () => void this.connectCurrent());
    this.disconnectButton.addEventListener('click', () => {
      if (!this.agentId) return;
      if (globalThis.confirm('Remove this Local Memory connection? No files will be deleted.')) {
        void this.disconnectCurrent();
      }
    });
  }

  async show(agentId: string | null): Promise<void> {
    this.agentId = agentId;
    this.permissionRenewal = null;
    const generation = ++this.renderGeneration;
    const isCurrent = () => this.agentId === agentId && this.renderGeneration === generation;
    this.section.classList.remove('hidden');

    if (!agentId) {
      this.renderState(
        'Not connected',
        'Save this agent before connecting a Local Memory folder.',
        false,
        false
      );
      return;
    }

    this.renderState('Checking…', 'Checking folder access.', false, false);
    this.section.setAttribute('aria-busy', 'true');

    let memory;
    try {
      memory = await this.manager.resolve(agentId);
    } catch {
      if (!isCurrent()) return;
      this.renderState(
        'Status unavailable',
        'AgentBoard could not check this folder connection.',
        true,
        true,
        'error'
      );
      this.connectButton.textContent = 'Choose folder';
      return;
    }
    if (!isCurrent()) return;

    if (memory.state === 'unmounted') {
      this.renderState(
        'Not connected',
        'Connect a folder to enable durable Local Memory.',
        true,
        false
      );
      return;
    }

    if (memory.state === 'available') {
      this.renderState('Connected', `Folder: ${memory.rootName}`, true, true, 'connected');
      this.connectButton.textContent = 'Change folder';
      return;
    }

    const detail =
      memory.reason === 'permission-required'
        ? 'Browser permission must be restored.'
        : memory.error.message;
    if (memory.reason === 'permission-required') {
      try {
        const renewal = await this.manager.preparePermissionRenewal(agentId);
        if (!isCurrent()) return;
        this.permissionRenewal = renewal;
      } catch (error) {
        if (!isCurrent()) return;
        const message =
          error instanceof MemoryMountError
            ? error.message
            : 'AgentBoard could not prepare folder access.';
        this.renderState('Reconnect required', message, true, true, 'error');
        this.connectButton.textContent = 'Choose folder';
        return;
      }
    }

    this.renderState(
      'Reconnect required',
      memory.rootName ? `Folder: ${memory.rootName}. ${detail}` : detail,
      true,
      true,
      'error'
    );
    this.connectButton.textContent = this.permissionRenewal
      ? 'Restore folder access'
      : 'Choose folder';
  }

  async removeBinding(agentId: string): Promise<void> {
    // The worker owns live tool closures, so revoke it before changing IndexedDB.
    await this.notify(agentId);
    await this.manager.disconnect(agentId);
    try {
      await this.notify(agentId);
    } catch {
      // A stopped worker will observe the deleted binding when it starts again.
    }
  }

  private async connectCurrent(): Promise<void> {
    const agentId = this.agentId;
    if (!agentId) return;
    const generation = this.renderGeneration;
    const renewal = this.permissionRenewal;
    const isCurrent = () => this.agentId === agentId && this.renderGeneration === generation;

    this.renderBusy(renewal ? 'Restoring access…' : 'Connecting folder…');
    try {
      if (renewal) {
        // renewal() invokes requestPermission synchronously in this click task.
        await Promise.all([renewal(), this.notify(agentId)]);
        if (!isCurrent()) return;
      } else {
        const handle = await this.picker();
        if (!isCurrent()) return;

        let permission = await handle.queryPermission({ mode: 'readwrite' });
        if (!isCurrent()) return;
        if (permission !== 'granted') {
          permission = await handle.requestPermission({ mode: 'readwrite' });
          if (!isCurrent()) return;
        }
        if (permission !== 'granted') throw new MemoryMountError('PERMISSION_REQUIRED');

        await this.notify(agentId);
        if (!isCurrent()) return;
        await this.manager.connect(agentId, handle);
      }

      try {
        await this.notify(agentId);
      } catch {
        // The next worker start will load the current binding.
      }
      if (isCurrent()) await this.show(agentId);
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof DOMException && error.name === 'AbortError') {
        await this.show(agentId);
        return;
      }

      const message =
        error instanceof MemoryMountError
          ? error.message
          : 'AgentBoard could not connect that Local Memory folder.';
      const refresh = this.show(agentId);
      const refreshGeneration = this.renderGeneration;
      await refresh;
      if (this.agentId !== agentId || this.renderGeneration !== refreshGeneration) return;
      this.state.textContent = 'Connection failed';
      this.state.dataset.tone = 'error';
      this.detail.textContent = message;
    }
  }

  private async disconnectCurrent(): Promise<void> {
    const agentId = this.agentId;
    if (!agentId) return;
    const generation = this.renderGeneration;
    const isCurrent = () => this.agentId === agentId && this.renderGeneration === generation;

    this.renderBusy('Removing connection…');
    try {
      await this.removeBinding(agentId);
      if (isCurrent()) {
        await this.show(agentId);
        this.connectButton.focus();
      }
    } catch {
      if (!isCurrent()) return;
      this.renderState(
        'Removal failed',
        'AgentBoard could not remove the folder connection. No files were deleted.',
        true,
        true,
        'error'
      );
      this.connectButton.textContent = 'Choose folder';
    }
  }

  private renderState(
    state: string,
    detail: string,
    canConnect: boolean,
    canDisconnect: boolean,
    tone: 'neutral' | 'connected' | 'error' = 'neutral'
  ): void {
    this.section.setAttribute('aria-busy', 'false');
    this.state.textContent = state;
    this.state.dataset.tone = tone;
    this.detail.textContent = detail;
    this.connectButton.disabled = !canConnect;
    this.connectButton.textContent = canDisconnect
      ? 'Reconnect or change folder'
      : 'Connect folder';
    this.disconnectButton.classList.toggle('hidden', !canDisconnect);
    this.disconnectButton.disabled = !canDisconnect;
  }

  private renderBusy(state: string): void {
    this.section.setAttribute('aria-busy', 'true');
    this.state.textContent = state;
    this.state.dataset.tone = 'neutral';
    this.connectButton.disabled = true;
    this.disconnectButton.disabled = true;
  }
}
