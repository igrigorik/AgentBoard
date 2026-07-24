/** Native dialog lifecycle shared by the Options editors. */

import log from '@lib/logger';

type ModalCallback = () => void | Promise<void>;

interface ModalState {
  modalId: string;
  onClose?: ModalCallback;
  cancelHandler: (event: Event) => void;
  previouslyFocused?: HTMLElement;
}

function getDialog(modalId: string): HTMLDialogElement | null {
  const modal = document.getElementById(modalId);
  if (modal instanceof HTMLDialogElement) return modal;
  log.error('Options dialog not found');
  return null;
}

function focusableElements(modal: HTMLDialogElement): HTMLElement[] {
  return Array.from(
    modal.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => !element.matches(':disabled') && !element.closest('.hidden'));
}

let currentModal: ModalState | null = null;

export function openModal(modalId: string, onClose?: ModalCallback): void {
  if (currentModal) closeModal(currentModal.modalId);

  const modal = getDialog(modalId);
  if (!modal) return;

  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const cancelHandler = (event: Event) => {
    // Route Escape through the same cleanup and focus-restoration path as buttons.
    event.preventDefault();
    closeModal(modalId);
  };

  modal.addEventListener('cancel', cancelHandler);
  modal.classList.remove('hidden');
  modal.showModal();
  currentModal = { modalId, onClose, cancelHandler, previouslyFocused };

  // Native dialogs own focus trapping. We only preserve the product preference
  // for an editable control ahead of the visually earlier close button.
  const focusable = focusableElements(modal);
  const editable = focusable.find((element) => element.matches('input, select, textarea'));
  (editable ?? focusable[0])?.focus();
}

export function closeModal(modalId: string): void {
  const modal = getDialog(modalId);
  if (!modal) return;

  const closingState = currentModal?.modalId === modalId ? currentModal : null;
  if (closingState) modal.removeEventListener('cancel', closingState.cancelHandler);
  if (modal.open) modal.close();
  modal.classList.add('hidden');

  if (!closingState) return;
  currentModal = null;
  closingState.previouslyFocused?.focus();
  try {
    void Promise.resolve(closingState.onClose?.()).catch(() => {
      log.error('Modal close callback failed');
    });
  } catch {
    log.error('Modal close callback failed');
  }
}

export function isModalOpen(modalId?: string): boolean {
  return modalId ? currentModal?.modalId === modalId : currentModal !== null;
}

/** Clicking the empty dialog surface represents its native backdrop. */
export function setupBackdropHandler(modalId: string): void {
  const modal = getDialog(modalId);
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) closeModal(modalId);
  });
}
