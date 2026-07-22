/**
 * Centralized modal management utility
 *
 * Handles common modal operations:
 * - Open/close with transition support
 * - ESC key dismissal
 * - Backdrop click dismissal
 * - Focus trap (basic)
 * - Cleanup on close
 *
 * Why centralized? Previously had 6+ duplicate modal implementations across
 * options page files. This consolidates the logic and ensures consistent UX.
 */

import log from '@lib/logger';

type ModalCallback = () => void | Promise<void>;

interface ModalState {
  modalId: string;
  onClose?: ModalCallback;
  keyHandler?: (e: KeyboardEvent) => void;
  previouslyFocused?: HTMLElement;
}

function focusableElements(modal: HTMLElement): HTMLElement[] {
  return Array.from(
    modal.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => !element.matches(':disabled') && !element.closest('.hidden'));
}

// Track currently open modal
let currentModal: ModalState | null = null;

/**
 * Opens a modal by ID
 *
 * @param modalId - The DOM element ID of the modal to open
 * @param onClose - Optional callback to execute when modal closes
 */
export function openModal(modalId: string, onClose?: ModalCallback): void {
  // Close any currently open modal first
  if (currentModal) {
    closeModal(currentModal.modalId);
  }

  const modal = document.getElementById(modalId);
  if (!modal) {
    log.error(`Modal with ID "${modalId}" not found`);
    return;
  }

  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const keyHandler = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      closeModal(modalId);
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = focusableElements(modal);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!(document.activeElement instanceof Node) || !modal.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  document.addEventListener('keydown', keyHandler);
  modal.classList.remove('hidden');

  currentModal = { modalId, onClose, keyHandler, previouslyFocused };
  const focusable = focusableElements(modal);
  const firstEnabledFormControl = focusable.find((element) =>
    element.matches('input, select, textarea')
  );
  (firstEnabledFormControl ?? focusable[0])?.focus();
}

/**
 * Closes a modal by ID
 *
 * @param modalId - The DOM element ID of the modal to close
 */
export function closeModal(modalId: string): void {
  const modal = document.getElementById(modalId);
  if (!modal) {
    log.warn(`Modal with ID "${modalId}" not found`);
    return;
  }

  const closingState = currentModal?.modalId === modalId ? currentModal : null;
  if (closingState?.keyHandler) document.removeEventListener('keydown', closingState.keyHandler);

  modal.classList.add('hidden');

  if (closingState) {
    // Clear state before user cleanup so a callback can safely open another modal.
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
}

/**
 * Check if a modal is currently open
 *
 * @param modalId - Optional modal ID to check. If omitted, checks if any modal is open.
 * @returns true if the specified modal (or any modal) is open
 */
export function isModalOpen(modalId?: string): boolean {
  if (modalId) {
    return currentModal?.modalId === modalId;
  }
  return currentModal !== null;
}

/**
 * Setup backdrop click handler for a modal
 * Registers click handler on the backdrop element to close the modal
 *
 * @param modalId - The modal ID
 * @param backdropSelector - CSS selector for the backdrop element within the modal
 */
export function setupBackdropHandler(modalId: string, backdropSelector = '.modal-backdrop'): void {
  const modal = document.getElementById(modalId);
  if (!modal) return;

  const backdrop = modal.querySelector(backdropSelector);
  if (!backdrop) return;

  backdrop.addEventListener('click', () => closeModal(modalId));
}
