/**
 * StreamingMarkdownRenderer - Integrates streaming-markdown library with our chat UI
 *
 * This module provides a bridge between the streaming-markdown parser and our DOM structure,
 * handling incremental markdown rendering optimized for AI streaming responses.
 */

import * as smd from 'streaming-markdown';
import type { Renderer, Parser, Token, Attr } from 'streaming-markdown';
import log from '../lib/logger';
import Prism from 'prismjs';

// Import Prism languages with correct dependency order
// CRITICAL: Order matters! Languages must be loaded after their dependencies

// Base/Core languages (no dependencies)
import 'prismjs/components/prism-clike'; // Base for C-like languages
import 'prismjs/components/prism-markup'; // Base for HTML, XML, JSX, TSX
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-regex';

// Markup templating - required for PHP and others
import 'prismjs/components/prism-markup-templating';

// Languages with clike dependency
import 'prismjs/components/prism-c'; // Depends on clike
import 'prismjs/components/prism-javascript'; // Depends on clike

// Languages that depend on C
import 'prismjs/components/prism-cpp'; // Depends on c

// Languages that depend on JavaScript
import 'prismjs/components/prism-typescript'; // Depends on javascript
import 'prismjs/components/prism-jsx'; // Depends on javascript + markup
import 'prismjs/components/prism-tsx'; // Depends on typescript + jsx

// Other C-like languages
import 'prismjs/components/prism-java'; // Depends on clike
import 'prismjs/components/prism-csharp'; // Depends on clike
import 'prismjs/components/prism-scala'; // Depends on java
import 'prismjs/components/prism-kotlin'; // Depends on clike

// Languages that depend on CSS
import 'prismjs/components/prism-scss'; // Depends on css
import 'prismjs/components/prism-less'; // Depends on css

// Languages that depend on markup
import 'prismjs/components/prism-markdown'; // Depends on markup
import 'prismjs/components/prism-php'; // Depends on markup-templating

// Independent languages (no critical dependencies)
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-swift';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-graphql';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-shell-session';
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-diff';
import 'prismjs/components/prism-git';
import 'prismjs/components/prism-makefile';
import 'prismjs/components/prism-nginx';

/**
 * Map common language aliases to Prism language identifiers
 * This prevents recreating the object on every code block
 */
const LANGUAGE_ALIAS_MAP: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  jsx: 'jsx',
  tsx: 'tsx',
  py: 'python',
  rb: 'ruby',
  yml: 'yaml',
  sh: 'bash',
  shell: 'bash',
  dockerfile: 'docker',
  md: 'markdown',
} as const;

/**
 * Renderer data structure for tracking DOM state
 */
interface RendererData {
  container: HTMLElement;
  nodes: HTMLElement[];
  currentLanguage?: string;
}

/**
 * StreamingMarkdownRenderer class - Main interface for streaming markdown rendering
 */
export class StreamingMarkdownRenderer {
  private parser: Parser;
  private container: HTMLElement;
  private rendererData: RendererData;

  constructor(container: HTMLElement) {
    this.container = container;
    this.rendererData = {
      container,
      nodes: [],
      currentLanguage: undefined,
    };

    // Create renderer with proper type signature
    const renderer: Renderer<RendererData> = {
      data: this.rendererData,
      add_token: this.addToken,
      end_token: this.endToken,
      add_text: this.addText,
      set_attr: this.setAttr,
    };

    this.parser = smd.parser(renderer);
  }

  /**
   * Called when a new token starts (e.g., paragraph, code block, bold, etc.)
   */
  private addToken = (data: RendererData, token: Token): void => {
    let element: HTMLElement;

    switch (token) {
      case smd.PARAGRAPH:
        element = document.createElement('p');
        break;

      case smd.HEADING_1:
        element = document.createElement('h1');
        break;
      case smd.HEADING_2:
        element = document.createElement('h2');
        break;
      case smd.HEADING_3:
        element = document.createElement('h3');
        break;
      case smd.HEADING_4:
        element = document.createElement('h4');
        break;
      case smd.HEADING_5:
        element = document.createElement('h5');
        break;
      case smd.HEADING_6:
        element = document.createElement('h6');
        break;

      case smd.CODE_BLOCK:
      case smd.CODE_FENCE: {
        element = document.createElement('pre');
        const codeEl = document.createElement('code');
        element.appendChild(codeEl);
        break;
      }

      case smd.CODE_INLINE:
        element = document.createElement('code');
        break;

      case smd.STRONG_AST:
      case smd.STRONG_UND:
        element = document.createElement('strong');
        break;

      case smd.ITALIC_AST:
      case smd.ITALIC_UND:
        element = document.createElement('em');
        break;

      case smd.STRIKE:
        element = document.createElement('del');
        break;

      case smd.LINK:
        element = document.createElement('a');
        break;

      case smd.IMAGE:
        element = document.createElement('img');
        break;

      case smd.LIST_UNORDERED:
        element = document.createElement('ul');
        break;

      case smd.LIST_ORDERED:
        element = document.createElement('ol');
        break;

      case smd.LIST_ITEM:
        element = document.createElement('li');
        break;

      case smd.CHECKBOX: {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.disabled = true;
        element = checkbox;
        break;
      }

      case smd.BLOCKQUOTE:
        element = document.createElement('blockquote');
        break;

      case smd.RULE: {
        element = document.createElement('hr');
        // hr doesn't have children, append immediately
        const parent = data.nodes.length > 0 ? data.nodes[data.nodes.length - 1] : data.container;
        parent.appendChild(element);
        return; // Don't push to stack
      }

      case smd.LINE_BREAK: {
        element = document.createElement('br');
        // br doesn't have children, append immediately
        const brParent = data.nodes.length > 0 ? data.nodes[data.nodes.length - 1] : data.container;
        brParent.appendChild(element);
        return; // Don't push to stack
      }

      case smd.TABLE:
        element = document.createElement('table');
        break;

      case smd.TABLE_ROW:
        element = document.createElement('tr');
        break;

      case smd.TABLE_CELL:
        // We'll determine if it's th or td based on position
        // For now, default to td
        element = document.createElement('td');
        break;

      default:
        // For unknown tokens, create a div
        element = document.createElement('div');
        element.className = `markdown-token-${token}`;
    }

    // Append to current container
    const targetContainer =
      data.nodes.length > 0 ? data.nodes[data.nodes.length - 1] : data.container;
    targetContainer.appendChild(element);

    // Push to stack
    data.nodes.push(element);
  };

  /**
   * Called when a token ends
   */
  private endToken = (data: RendererData): void => {
    const element = data.nodes.pop();

    // Apply syntax highlighting to completed code blocks
    if (element && element.tagName === 'PRE') {
      const codeEl = element.querySelector('code');
      if (codeEl) {
        if (data.currentLanguage) {
          // Map common aliases to Prism language names
          let prismLang = data.currentLanguage.toLowerCase();
          prismLang = LANGUAGE_ALIAS_MAP[prismLang] || prismLang;

          // Only apply highlighting if the language is supported
          if (Prism.languages[prismLang]) {
            const languageClass = `language-${prismLang}`;
            codeEl.className = languageClass;
            try {
              Prism.highlightElement(codeEl);
            } catch (error) {
              log.warn(`Failed to highlight ${prismLang} code:`, error);
            }
          } else {
            // Fallback to plain text for unsupported languages
            codeEl.className = 'language-plaintext';
          }
        } else {
          // No language specified, use plaintext
          codeEl.className = 'language-plaintext';
        }
      }
      data.currentLanguage = undefined;
    }
  };

  /**
   * Called to append text to the current token
   */
  private addText = (data: RendererData, text: string): void => {
    const current = data.nodes[data.nodes.length - 1];

    if (!current) {
      // If no current element, append directly to container
      data.container.appendChild(document.createTextNode(text));
      return;
    }

    // For code blocks, append to the code element inside pre
    if (current.tagName === 'PRE') {
      const codeEl = current.querySelector('code');
      if (codeEl) {
        codeEl.appendChild(document.createTextNode(text));
      }
    } else {
      current.appendChild(document.createTextNode(text));
    }
  };

  /**
   * Called to set additional attributes on the current token
   */
  private setAttr = (data: RendererData, attr: Attr, value: string): void => {
    const current = data.nodes[data.nodes.length - 1];
    if (!current) return;

    switch (attr) {
      case smd.HREF:
        if (current.tagName === 'A') {
          (current as HTMLAnchorElement).href = value;
          (current as HTMLAnchorElement).target = '_blank';
          (current as HTMLAnchorElement).rel = 'noopener noreferrer';
        }
        break;

      case smd.SRC:
        if (current.tagName === 'IMG') {
          (current as HTMLImageElement).src = value;
        }
        break;

      case smd.LANG:
        // Store language for code block highlighting
        data.currentLanguage = value;
        break;

      case smd.CHECKED:
        if (current.tagName === 'INPUT' && current.getAttribute('type') === 'checkbox') {
          (current as HTMLInputElement).checked = value === 'true';
        }
        break;

      case smd.START:
        if (current.tagName === 'OL') {
          (current as HTMLOListElement).start = parseInt(value, 10);
        }
        break;
    }
  };

  /**
   * Write a chunk of markdown to be rendered incrementally
   * Handles incomplete markdown gracefully (e.g., unterminated bold, code blocks)
   */
  write(chunk: string): void {
    smd.parser_write(this.parser, chunk);
  }

  /**
   * End the current streaming session and flush any remaining content
   */
  end(): void {
    smd.parser_end(this.parser);
  }

  /**
   * Reset the parser for a new message
   */
  reset(): void {
    // End current session if any
    this.end();
    // Create fresh parser with new renderer data
    this.rendererData = {
      container: this.container,
      nodes: [],
      currentLanguage: undefined,
    };

    const renderer: Renderer<RendererData> = {
      data: this.rendererData,
      add_token: this.addToken,
      end_token: this.endToken,
      add_text: this.addText,
      set_attr: this.setAttr,
    };

    this.parser = smd.parser(renderer);
  }

  /**
   * Static method for one-shot markdown rendering (non-streaming)
   */
  static renderComplete(container: HTMLElement, markdown: string): void {
    const renderer = new StreamingMarkdownRenderer(container);
    renderer.write(markdown);
    renderer.end();
  }
}
