/**
 * ReasoningBox Component - Collapsible UI for displaying model reasoning/thinking process
 *
 * Streams reasoning tokens in real-time as the model thinks through problems,
 * providing transparency into the AI's chain-of-thought process.
 */

import log from '../lib/logger';
import { CollapsibleBox } from './CollapsibleBox';
import { StreamingMarkdownRenderer } from './StreamingMarkdownRenderer';

export class ReasoningBox extends CollapsibleBox {
  private contentDiv: HTMLDivElement = document.createElement('div');
  private isStreaming = false;
  private markdownRenderer?: StreamingMarkdownRenderer;
  private chunks: string[] = [];
  private statusSpan?: HTMLSpanElement;
  private startTime?: number;

  constructor() {
    super();
    this.container = this.render();
  }

  render(): HTMLDivElement {
    this.container = document.createElement('div');
    this.container.className = 'reasoning-box';

    // Header (always visible, clickable to expand/collapse)
    this.headerDiv = document.createElement('div');
    this.headerDiv.className = 'reasoning-header';

    // Icon
    const iconSpan = document.createElement('span');
    iconSpan.className = 'reasoning-icon';
    iconSpan.textContent = '🧠';

    // Title
    const titleSpan = document.createElement('span');
    titleSpan.className = 'reasoning-title';
    titleSpan.textContent = 'Model Reasoning';

    // Status (will show "thinking..." or token count)
    this.statusSpan = document.createElement('span');
    this.statusSpan.className = 'reasoning-status';

    // Create chevron using base class method
    const chevron = this.createChevron();

    this.headerDiv.appendChild(iconSpan);
    this.headerDiv.appendChild(titleSpan);
    this.headerDiv.appendChild(this.statusSpan);
    this.headerDiv.appendChild(chevron);

    // Content area (collapsible, will contain reasoning text)
    this.contentDiv = document.createElement('div');
    this.contentDiv.className = 'reasoning-content';

    this.container.appendChild(this.headerDiv);
    this.container.appendChild(this.contentDiv);

    // Initialize toggle handler from base class
    this.initializeToggleHandler();

    return this.container;
  }

  /**
   * Start streaming reasoning - show loading state and expand
   * @param preserveContent - If true, keeps existing content (for merging adjacent segments)
   */
  startStreaming(preserveContent: boolean = false): void {
    this.isStreaming = true;
    this.container.classList.add('streaming');

    // Track start time for duration calculation (only for new sessions)
    if (!preserveContent || !this.startTime) {
      this.startTime = Date.now();
    }

    // Auto-expand to show reasoning as it streams
    if (!this.isExpanded) {
      this.expand();
    }

    // Update status with pulsing indicator
    if (this.statusSpan) {
      this.statusSpan.innerHTML = '<span class="pulse">● thinking...</span>';
    }

    // Initialize markdown renderer for the content
    if (!this.markdownRenderer) {
      this.markdownRenderer = new StreamingMarkdownRenderer(this.contentDiv);
    } else if (!preserveContent) {
      // Clear content for new reasoning session (unless we're merging)
      this.contentDiv.innerHTML = '';
      this.markdownRenderer.reset();
    }

    // Only clear chunks if we're not preserving content
    if (!preserveContent) {
      this.chunks = [];
    }
  }

  /**
   * Append a chunk of reasoning text as it streams
   */
  appendChunk(text: string): void {
    if (!text) return;

    this.chunks.push(text);

    // Stream text through markdown renderer for proper formatting
    if (this.markdownRenderer) {
      this.markdownRenderer.write(text);
    } else {
      // Fallback: append as text if no renderer
      this.contentDiv.appendChild(document.createTextNode(text));
    }

    // Auto-scroll to bottom as content streams
    this.contentDiv.scrollTop = this.contentDiv.scrollHeight;
  }

  /**
   * Finish streaming - update status and optionally show token count
   */
  finishStreaming(usage?: { reasoningTokens?: number }): void {
    this.isStreaming = false;
    this.container.classList.remove('streaming');

    // End markdown renderer session
    if (this.markdownRenderer) {
      this.markdownRenderer.end();
    }

    // Calculate duration and update status
    if (this.statusSpan) {
      let durationText = '';
      if (this.startTime) {
        const duration = Date.now() - this.startTime;
        if (duration < 1000) {
          durationText = `${duration}ms`;
        } else {
          durationText = `${(duration / 1000).toFixed(1)}s`;
        }
      }

      const tokenInfo = usage?.reasoningTokens
        ? ` • ${usage.reasoningTokens.toLocaleString()} tokens`
        : '';

      this.statusSpan.innerHTML = `<span class="complete">${durationText}${tokenInfo}</span>`;
    }

    // Keep expanded briefly so user can see, then collapse
    // But only if there's substantial content
    if (this.chunks.length > 0) {
      log.debug('[ReasoningBox] Will auto-collapse in 3 seconds');
      setTimeout(() => {
        if (this.isExpanded && !this.isStreaming) {
          log.debug('[ReasoningBox] Auto-collapsing now');
          this.collapse();
        }
      }, 3000);
    }
  }

  /**
   * Hook: Handle expansion - add expanded class to content div
   */
  protected onExpand(): void {
    this.contentDiv.classList.add('expanded');
  }

  /**
   * Hook: Handle collapse - remove expanded class from content div
   */
  protected onCollapse(): void {
    this.contentDiv.classList.remove('expanded');

    // Debug: Log collapse and check visibility
    log.debug('[ReasoningBox] Collapsed. Container visibility:', {
      offsetHeight: this.container.offsetHeight,
      classList: this.container.classList.toString(),
      contentClassList: this.contentDiv.classList.toString(),
      parentElement: this.container.parentElement?.tagName,
    });
  }

  /**
   * Get the full reasoning text collected so far
   */
  getReasoningText(): string {
    return this.chunks.join('');
  }

  /**
   * Check if reasoning is currently streaming
   */
  isStreamingActive(): boolean {
    return this.isStreaming;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.markdownRenderer = undefined;
    this.chunks = [];
  }
}
