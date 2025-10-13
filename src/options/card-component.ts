/**
 * Shared card component for consistent rendering across Options sections
 * Provides unified card layout with flexible content rendering
 */

export interface Badge {
  text: string;
  className: string;
}

export interface Detail {
  label: string;
  value: string;
  valueClassName?: string;
}

export interface CardConfig {
  id: string;
  title: string;
  subtitle?: string;
  badges?: Badge[];
  details?: Detail[];
  customContent?: HTMLElement;
  toggle?: {
    enabled: boolean;
    label: string;
    onToggle: () => void;
  };
  onEdit: () => void;
}

/**
 * Create a consistent card element
 * Cards have: header (title, badges), body (details or custom content), footer (toggle + edit)
 */
export function createCard(config: CardConfig): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card card-clickable';
  card.dataset.cardId = config.id;

  // Make card clickable
  card.addEventListener('click', config.onEdit);

  // === Header ===
  const header = document.createElement('div');
  header.className = 'card-header';

  const info = document.createElement('div');
  info.className = 'card-info';

  const titleEl = document.createElement('h3');
  titleEl.className = 'card-title';
  titleEl.textContent = config.title;
  info.appendChild(titleEl);

  header.appendChild(info);

  // Right side: badges and toggle
  const headerActions = document.createElement('div');
  headerActions.className = 'card-header-actions';

  // Badges
  if (config.badges && config.badges.length > 0) {
    const badgesContainer = document.createElement('div');
    badgesContainer.className = 'card-badges';
    config.badges.forEach((badge) => {
      const badgeEl = document.createElement('span');
      badgeEl.className = badge.className;
      badgeEl.textContent = badge.text;
      badgesContainer.appendChild(badgeEl);
    });
    headerActions.appendChild(badgesContainer);
  }

  // Toggle (if applicable)
  if (config.toggle) {
    const toggleContainer = document.createElement('div');
    toggleContainer.className = 'card-toggle-header';

    const toggleLabel = document.createElement('label');
    toggleLabel.textContent = config.toggle.label;
    toggleContainer.appendChild(toggleLabel);

    const toggleSwitch = document.createElement('div');
    toggleSwitch.className = `toggle-switch ${config.toggle.enabled ? 'enabled' : ''}`;
    const toggleHandler = config.toggle.onToggle;
    toggleSwitch.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent card click from firing
      toggleHandler();
    });
    toggleContainer.appendChild(toggleSwitch);

    headerActions.appendChild(toggleContainer);
  }

  header.appendChild(headerActions);
  card.appendChild(header);

  // Subtitle (if present) - spans full width below header
  if (config.subtitle) {
    const subtitleEl = document.createElement('p');
    subtitleEl.className = 'card-subtitle';
    subtitleEl.textContent = config.subtitle;
    card.appendChild(subtitleEl);
  }

  // === Body ===
  const body = document.createElement('div');
  body.className = 'card-body';

  // Either render details or custom content
  if (config.customContent) {
    body.appendChild(config.customContent);
  } else if (config.details && config.details.length > 0) {
    config.details.forEach((detail) => {
      const detailEl = document.createElement('div');
      detailEl.className = 'card-detail';

      const labelEl = document.createElement('span');
      labelEl.className = 'detail-label';
      labelEl.textContent = detail.label;
      detailEl.appendChild(labelEl);

      const valueEl = document.createElement('span');
      valueEl.className = `detail-value ${detail.valueClassName || ''}`;
      valueEl.textContent = detail.value;
      detailEl.appendChild(valueEl);

      body.appendChild(detailEl);
    });
  }

  card.appendChild(body);

  return card;
}

/**
 * Setup modal footer with consistent action layout
 * Layout: [Delete (left)] ... [Test (optional)] [Save (right)]
 */
export interface ModalFooterConfig {
  modalId: string;
  onSave: () => void;
  onDelete?: () => void;
  onTest?: () => void;
  deleteLabel?: string;
}

export function setupModalFooter(config: ModalFooterConfig): void {
  const modal = document.getElementById(config.modalId);
  if (!modal) return;

  const footer = modal.querySelector('.modal-footer');
  if (!footer) return;

  // Clear existing footer
  footer.innerHTML = '';

  // Left side: Delete button (if applicable)
  if (config.onDelete) {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'button button-danger modal-delete-btn';
    deleteBtn.textContent = config.deleteLabel || 'Delete';
    deleteBtn.addEventListener('click', config.onDelete);
    footer.appendChild(deleteBtn);
  }

  // Spacer to push right-side buttons
  const spacer = document.createElement('div');
  spacer.style.flex = '1';
  footer.appendChild(spacer);

  // Right side: Test button (optional)
  if (config.onTest) {
    const testBtn = document.createElement('button');
    testBtn.className = 'button button-secondary modal-test-btn';
    testBtn.textContent = 'Test';
    testBtn.addEventListener('click', config.onTest);
    footer.appendChild(testBtn);
  }

  // Right side: Save button
  const saveBtn = document.createElement('button');
  saveBtn.className = 'button button-primary modal-save-btn';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', config.onSave);
  footer.appendChild(saveBtn);
}

/**
 * Show status message in modal
 */
export function showModalStatus(
  modalId: string,
  message: string,
  type: 'success' | 'error' | 'info'
): void {
  const statusEl = document.getElementById(`${modalId}-status`);
  if (!statusEl) return;

  statusEl.textContent = message;
  statusEl.className = `modal-status ${type}`;

  // Auto-hide after delay
  setTimeout(
    () => {
      statusEl.classList.add('hidden');
    },
    type === 'error' ? 5000 : 3000
  );
}

/**
 * Helper to escape HTML for safe rendering
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
