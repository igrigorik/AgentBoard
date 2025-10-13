/**
 * ToolCallBox Component - Collapsible UI for displaying tool calls
 */

import type { ToolCall } from '../types';
import JSONFormatter from 'json-formatter-js';
import { CollapsibleBox } from './CollapsibleBox';

export class ToolCallBox extends CollapsibleBox {
  private detailsSection: HTMLDivElement | null = null;
  private outputSection: HTMLDivElement | null = null;
  private statusIcon: HTMLSpanElement | null = null;
  private durationBadge: HTMLSpanElement | null = null;

  constructor(private toolCall: ToolCall) {
    super();
    this.container = this.render();
  }

  render(): HTMLDivElement {
    // Main container with collapsed/expanded state
    this.container = document.createElement('div');
    this.container.className = 'tool-call-box';
    this.container.dataset.status = this.toolCall.status;
    this.container.dataset.toolId = this.toolCall.id;

    // Header (always visible)
    const header = this.createHeader();

    // Details section (collapsible)
    this.detailsSection = this.createDetails();

    this.container.appendChild(header);
    this.container.appendChild(this.detailsSection);

    return this.container;
  }

  private createHeader(): HTMLDivElement {
    const header = document.createElement('div');
    header.className = 'tool-call-header';

    // Status icon
    this.statusIcon = this.createStatusIcon();

    // Tool name
    const toolName = document.createElement('span');
    toolName.className = 'tool-name';
    toolName.textContent = this.toolCall.toolName;

    // Duration badge with status indicator (if completed)
    this.durationBadge = this.createDurationBadge();

    // Create chevron using base class method
    const chevron = this.createChevron();

    header.appendChild(this.statusIcon);
    header.appendChild(toolName);
    if (this.durationBadge) {
      header.appendChild(this.durationBadge);
    }
    header.appendChild(chevron);

    // Set headerDiv for base class toggle handler
    this.headerDiv = header;
    this.initializeToggleHandler();

    return header;
  }

  private createStatusIcon(): HTMLSpanElement {
    const icon = document.createElement('span');
    icon.className = `status-icon status-${this.toolCall.status}`;

    switch (this.toolCall.status) {
      case 'pending':
        icon.textContent = '○';
        icon.style.color = 'var(--muted)';
        icon.style.fontSize = '16px';
        break;
      case 'running':
        icon.textContent = '◉';
        icon.style.color = 'var(--primary)';
        icon.style.fontSize = '16px';
        icon.classList.add('spinning');
        break;
      case 'success':
        icon.textContent = '✓';
        icon.style.color = '#10b981';
        icon.style.fontSize = '14px';
        icon.style.fontWeight = 'bold';
        break;
      case 'error':
        icon.textContent = '✗';
        icon.style.color = '#ef4444';
        icon.style.fontSize = '14px';
        icon.style.fontWeight = 'bold';
        break;
    }

    return icon;
  }

  private createDurationBadge(): HTMLSpanElement | null {
    if (!this.toolCall.duration) return null;

    const badge = document.createElement('span');
    badge.className = 'duration-badge';

    // Format duration text
    const duration = this.toolCall.duration;
    if (duration < 1000) {
      badge.textContent = `${duration}ms`;
    } else {
      badge.textContent = `${(duration / 1000).toFixed(1)}s`;
    }

    return badge;
  }

  private createDetails(): HTMLDivElement {
    const details = document.createElement('div');
    details.className = 'tool-call-details';

    // Input section
    const inputSection = this.createSection('Input', this.toolCall.input);
    details.appendChild(inputSection);

    // Output section (if available) or pending message
    this.outputSection = document.createElement('div');
    this.outputSection.className = 'tool-section';
    this.updateOutputSection();
    details.appendChild(this.outputSection);

    // Error section (if applicable)
    if (this.toolCall.status === 'error' && this.toolCall.error) {
      const errorSection = this.createSection('Error', this.toolCall.error, 'error');
      details.appendChild(errorSection);
    }

    return details;
  }

  private createSection(
    label: string,
    content: unknown,
    type: 'normal' | 'error' = 'normal'
  ): HTMLDivElement {
    const section = document.createElement('div');
    section.className = `tool-section ${type === 'error' ? 'tool-section-error' : ''}`;

    const sectionLabel = document.createElement('div');
    sectionLabel.className = 'tool-section-label';
    sectionLabel.textContent = label;

    const sectionContent = document.createElement('div');
    sectionContent.className = 'tool-section-content';

    // Try to parse and use JSONFormatter for objects/JSON
    let jsonObject: unknown = null;
    let isJson = false;

    if (typeof content === 'string') {
      // Try to parse string as JSON
      try {
        jsonObject = JSON.parse(content);
        isJson = true;
      } catch {
        // Not JSON, display as plain text
        sectionContent.textContent = content;
      }
    } else if (content !== null && content !== undefined && typeof content === 'object') {
      jsonObject = content;
      isJson = true;
    } else {
      // Display primitives as text
      sectionContent.textContent = String(content);
    }

    // Use JSONFormatter for JSON content
    if (isJson && jsonObject !== null) {
      // Detect if dark mode is active
      const isDarkMode =
        window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

      const formatter = new JSONFormatter(jsonObject, 3, {
        hoverPreviewEnabled: false,
        hoverPreviewArrayCount: 100,
        hoverPreviewFieldCount: 5,
        theme: isDarkMode ? 'dark' : '', // Use dark theme if in dark mode
        animateOpen: true,
        animateClose: true,
        useToJSON: true,
        maxArrayItems: 100,
        exposePath: true,
      });

      // Add wrapper for JSONFormatter output
      const jsonWrapper = document.createElement('div');
      jsonWrapper.className = 'json-formatter-wrapper';
      jsonWrapper.appendChild(formatter.render());
      sectionContent.appendChild(jsonWrapper);
    }

    section.appendChild(sectionLabel);
    section.appendChild(sectionContent);

    return section;
  }

  private updateOutputSection(): void {
    if (!this.outputSection) return;

    this.outputSection.innerHTML = '';

    if (this.toolCall.status === 'pending' || this.toolCall.status === 'running') {
      // Show pending/loading state
      const label = document.createElement('div');
      label.className = 'tool-section-label';
      label.textContent = 'Output';

      const content = document.createElement('div');
      content.className = 'tool-section-content tool-section-pending';
      content.innerHTML = `
        <span class="pending-message">
          ${this.toolCall.status === 'running' ? 'Executing...' : 'Waiting...'}
        </span>
      `;

      this.outputSection.appendChild(label);
      this.outputSection.appendChild(content);
    } else if (this.toolCall.output !== undefined) {
      // Show actual output
      const outputContent = this.createSection('Output', this.toolCall.output);
      this.outputSection.appendChild(outputContent);
    }
  }

  /**
   * Hook: Handle expansion - add expanded class to details section
   */
  protected onExpand(): void {
    if (this.detailsSection) {
      this.detailsSection.classList.add('expanded');
    }
  }

  /**
   * Hook: Handle collapse - remove expanded class from details section
   */
  protected onCollapse(): void {
    if (this.detailsSection) {
      this.detailsSection.classList.remove('expanded');
    }
  }

  /**
   * Update the tool call result
   */
  updateResult(output: unknown, status: 'success' | 'error', error?: string): void {
    // Update the tool call data
    this.toolCall.output = output;
    this.toolCall.status = status;
    this.toolCall.error = error;
    this.toolCall.endTime = Date.now();
    if (this.toolCall.startTime) {
      this.toolCall.duration = this.toolCall.endTime - this.toolCall.startTime;
    }

    // Update status in DOM
    this.container.dataset.status = status;

    // Update status icon
    if (this.statusIcon) {
      const newIcon = this.createStatusIcon();
      this.statusIcon.replaceWith(newIcon);
      this.statusIcon = newIcon;
    }

    // Update duration badge
    if (this.toolCall.duration && !this.durationBadge) {
      this.durationBadge = this.createDurationBadge();
      if (this.durationBadge) {
        const header = this.container.querySelector('.tool-call-header');
        const chevron = header?.querySelector('.chevron');
        if (header && chevron) {
          header.insertBefore(this.durationBadge, chevron);
        }
      }
    } else if (this.durationBadge) {
      const newBadge = this.createDurationBadge();
      if (newBadge) {
        this.durationBadge.replaceWith(newBadge);
        this.durationBadge = newBadge;
      }
    }

    // Update output section
    this.updateOutputSection();

    // Add error section if needed
    if (status === 'error' && error && this.detailsSection) {
      const existingError = this.detailsSection.querySelector('.tool-section-error');
      if (!existingError) {
        const errorSection = this.createSection('Error', error, 'error');
        this.detailsSection.appendChild(errorSection);
      }
    }
  }

  /**
   * Get the tool call ID
   */
  getToolCallId(): string {
    return this.toolCall.id;
  }
}
