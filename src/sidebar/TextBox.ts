/**
 * TextBox Component - Container for streaming text content from AI responses
 *
 * Encapsulates a single text block with its own StreamingMarkdownRenderer,
 * managing the lifecycle of text streaming independently from other UI elements.
 */

import log from '../lib/logger';
import { StreamingMarkdownRenderer } from './StreamingMarkdownRenderer';

export class TextBox {
  private container: HTMLDivElement;
  private contentDiv: HTMLDivElement;
  private renderer: StreamingMarkdownRenderer;
  private blockId: string;
  private isStreaming = false;

  constructor(blockId: string) {
    this.blockId = blockId;
    // Initialize contentDiv first
    this.contentDiv = document.createElement('div');
    this.contentDiv.className = 'message-content';

    // Now create container and set up DOM
    this.container = this.render();

    // Initialize renderer with content div
    this.renderer = new StreamingMarkdownRenderer(this.contentDiv);
  }

  /**
   * Create DOM structure for the text box
   */
  private render(): HTMLDivElement {
    const container = document.createElement('div');
    container.className = 'message message-assistant text-box';
    container.setAttribute('data-block-id', this.blockId);

    // Append the already-created contentDiv
    container.appendChild(this.contentDiv);

    return container;
  }

  /**
   * Start streaming - mark box as actively receiving content
   */
  startStreaming(): void {
    this.isStreaming = true;
    this.container.classList.add('streaming');
  }

  /**
   * Append a chunk of text to the stream
   */
  appendChunk(text: string): void {
    if (!text) return;

    if (this.isStreaming) {
      this.renderer.write(text);
    } else {
      log.warn(`[TextBox] Attempted to append chunk to non-streaming box ${this.blockId}`);
    }
  }

  /**
   * Finish streaming - clean up renderer and update visual state
   */
  finishStreaming(): void {
    if (this.isStreaming) {
      this.renderer.end();
      this.container.classList.remove('streaming');
      this.isStreaming = false;
    }
  }

  /**
   * Get the DOM element for insertion into the chat
   */
  getElement(): HTMLDivElement {
    return this.container;
  }

  /**
   * Get the block ID
   */
  getBlockId(): string {
    return this.blockId;
  }

  /**
   * Check if currently streaming
   */
  isStreamingActive(): boolean {
    return this.isStreaming;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    // Ensure streaming is ended
    if (this.isStreaming) {
      this.finishStreaming();
    }
    // Clear references
    this.container.remove();
  }
}
