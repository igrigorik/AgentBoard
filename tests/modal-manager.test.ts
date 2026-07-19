import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeModal, openModal } from '../src/options/modal-manager';

afterEach(() => {
  closeModal('test-modal');
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

function renderModal(): void {
  document.body.innerHTML = `
    <button id="trigger">Open</button>
    <div id="test-modal" class="modal hidden">
      <input id="first-control">
      <button id="last-control">Done</button>
    </div>
  `;
}

describe('modal focus management', () => {
  it('focuses the first form control, traps Tab, and restores prior focus', () => {
    renderModal();
    const trigger = document.getElementById('trigger') as HTMLButtonElement;
    const first = document.getElementById('first-control') as HTMLInputElement;
    const last = document.getElementById('last-control') as HTMLButtonElement;
    trigger.focus();

    openModal('test-modal');
    expect(document.activeElement).toBe(first);

    last.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    expect(document.activeElement).toBe(first);

    closeModal('test-modal');
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on Escape and invokes cleanup once', () => {
    renderModal();
    const onClose = vi.fn();
    openModal('test-modal', onClose);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(document.getElementById('test-modal')?.classList.contains('hidden')).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
