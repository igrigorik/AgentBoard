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
  escapeKeyHandler?: (e: KeyboardEvent) => void;
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

  // Setup ESC key handler for this modal
  const escapeKeyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeModal(modalId);
    }
  };

  // Register ESC listener
  document.addEventListener('keydown', escapeKeyHandler);

  // Show modal
  modal.classList.remove('hidden');

  // Focus first focusable element (accessibility)
  // eslint-disable-next-line no-undef
  requestAnimationFrame(() => {
    const firstInput = modal.querySelector<HTMLElement>(
      'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])'
    );
    firstInput?.focus();
  });

  // Track state
  currentModal = {
    modalId,
    onClose,
    escapeKeyHandler,
  };
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

  // Remove ESC listener if this is the current modal
  if (currentModal?.modalId === modalId && currentModal.escapeKeyHandler) {
    document.removeEventListener('keydown', currentModal.escapeKeyHandler);
  }

  // Hide modal
  modal.classList.add('hidden');

  // Execute cleanup callback
  if (currentModal?.modalId === modalId && currentModal.onClose) {
    currentModal.onClose();
  }

  // Clear state
  if (currentModal?.modalId === modalId) {
    currentModal = null;
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
