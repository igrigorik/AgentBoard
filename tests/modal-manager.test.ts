import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeModal, openModal, setupBackdropHandler } from '../src/options/modal-manager';

function installDialogMethods(): HTMLDialogElement {
  const dialog = document.getElementById('test-modal');
  if (!(dialog instanceof HTMLDialogElement)) throw new Error('Test dialog missing');
  dialog.showModal = vi.fn(() => dialog.setAttribute('open', ''));
  dialog.close = vi.fn(() => dialog.removeAttribute('open'));
  return dialog;
}

afterEach(() => {
  closeModal('test-modal');
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

function renderModal(): HTMLDialogElement {
  document.body.innerHTML = `
    <button id="trigger">Open</button>
    <dialog id="test-modal" class="modal hidden">
      <input id="first-control">
      <button id="last-control">Done</button>
    </dialog>
  `;
  return installDialogMethods();
}

describe('native modal lifecycle', () => {
  it('opens natively, focuses the first form control, and restores prior focus', () => {
    const dialog = renderModal();
    const trigger = document.getElementById('trigger') as HTMLButtonElement;
    const first = document.getElementById('first-control') as HTMLInputElement;
    trigger.focus();

    openModal('test-modal');

    expect(dialog.showModal).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(first);

    closeModal('test-modal');
    expect(dialog.close).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('prefers a visible enabled form control over an earlier close button', () => {
    document.body.innerHTML = `
      <button id="trigger">Open</button>
      <dialog id="test-modal" class="modal hidden">
        <button id="close-control">Close</button>
        <textarea id="disabled-control" disabled></textarea>
        <fieldset disabled><input id="fieldset-disabled-control"></fieldset>
        <div class="hidden"><input id="hidden-control"></div>
        <input id="first-enabled-form-control">
      </dialog>
    `;
    installDialogMethods();

    openModal('test-modal');

    expect(document.activeElement).toBe(document.getElementById('first-enabled-form-control'));
  });

  it('falls back to an enabled button for a read-only dialog', () => {
    document.body.innerHTML = `
      <button id="trigger">Open</button>
      <dialog id="test-modal" class="modal hidden">
        <button id="close-control">Close</button>
        <textarea id="disabled-control" disabled></textarea>
        <fieldset disabled><input id="fieldset-disabled-control"></fieldset>
        <div class="hidden"><input id="hidden-control"></div>
      </dialog>
    `;
    installDialogMethods();

    openModal('test-modal');

    expect(document.activeElement).toBe(document.getElementById('close-control'));
  });

  it('routes native Escape cancellation through cleanup exactly once', () => {
    const dialog = renderModal();
    const onClose = vi.fn();
    openModal('test-modal', onClose);

    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));

    expect(dialog.open).toBe(false);
    expect(dialog.classList.contains('hidden')).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the native backdrop surface is clicked', () => {
    const dialog = renderModal();
    setupBackdropHandler('test-modal');
    openModal('test-modal');

    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(dialog.open).toBe(false);
  });
});
