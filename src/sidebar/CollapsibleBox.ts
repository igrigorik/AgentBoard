/**
 * CollapsibleBox - Base class for UI components with expand/collapse functionality
 *
 * Provides consistent expand/collapse behavior, chevron animation, and state
 * management for collapsible UI components (ReasoningBox and ToolCallBox).
 *
 * Key design decisions:
 * - Shared chevron SVG creation and rotation animation
 * - Consistent expand/collapse state management
 * - Subclasses define their own content areas (contentDiv vs detailsSection)
 * - Compatible with wrapper-based layout approach for consistent spacing
 */

export abstract class CollapsibleBox {
  protected container!: HTMLDivElement;
  protected headerDiv!: HTMLDivElement;
  protected isExpanded = false;
  private chevronSpan?: HTMLSpanElement;

  /**
   * Create the standard chevron SVG element for expand/collapse indicator
   * Used by both ReasoningBox and ToolCallBox for visual consistency
   */
  protected createChevron(): HTMLSpanElement {
    const chevron = document.createElement('span');
    chevron.className = 'chevron';
    chevron.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.5" 
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
    this.chevronSpan = chevron;
    return chevron;
  }

  /**
   * Initialize the click handler for expand/collapse on the header
   * Should be called after headerDiv is created in subclass
   */
  protected initializeToggleHandler(): void {
    if (this.headerDiv) {
      this.headerDiv.addEventListener('click', () => this.toggle());
    }
  }

  /**
   * Toggle expanded/collapsed state
   * Manages container classes and chevron rotation
   */
  toggle(): void {
    if (this.isExpanded) {
      this.collapse();
    } else {
      this.expand();
    }
  }

  /**
   * Expand the box
   * Adds expanded class to container and rotates chevron
   */
  expand(): void {
    this.isExpanded = true;
    this.container.classList.add('expanded');
    this.updateChevron();
    this.onExpand();
  }

  /**
   * Collapse the box
   * Removes expanded class from container and resets chevron
   */
  collapse(): void {
    this.isExpanded = false;
    this.container.classList.remove('expanded');
    this.updateChevron();
    this.onCollapse();
  }

  /**
   * Update chevron rotation based on expanded state
   */
  private updateChevron(): void {
    if (this.chevronSpan) {
      this.chevronSpan.style.transform = this.isExpanded ? 'rotate(90deg)' : '';
    }
  }

  /**
   * Hook for subclasses to handle expansion
   * Override to manage content area visibility
   */
  protected abstract onExpand(): void;

  /**
   * Hook for subclasses to handle collapse
   * Override to manage content area visibility
   */
  protected abstract onCollapse(): void;

  /**
   * Get the DOM element
   */
  getElement(): HTMLDivElement {
    return this.container;
  }
}
