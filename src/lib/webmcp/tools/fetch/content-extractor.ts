/**
 * Content extraction pipeline for fetched HTML
 * Converts HTML to LLM-optimized markdown using linkedom + Readability + htmlToMarkdown
 *
 * Pipeline:
 * 1. linkedom: Parse HTML in service worker (no native DOMParser, 12x smaller than jsdom)
 * 2. Readability: Extract article content, strip ads/nav/junk
 * 3. htmlToMarkdown: Convert to LLM-optimized markdown
 */

import { parseHTML } from 'linkedom';
import { Readability } from '../../vendor/readability.js';
import { htmlToMarkdown } from './html-to-markdown';

export interface ConvertToMarkdownOptions {
  /**
   * Source URL for metadata and link resolution
   */
  url: string;

  /**
   * Character threshold for Readability (default: 500)
   * Minimum chars an article must have to be considered valid
   */
  charThreshold?: number;

  /**
   * Preserve CSS classes (default: false)
   * Most semantic info is in structure, not classes
   */
  keepClasses?: boolean;
}

/**
 * Convert HTML content to markdown using existing pipeline
 * Reuses dom_readability's proven extraction logic
 *
 * @param content - Raw HTML content
 * @param options - Conversion options
 * @returns Markdown content with metadata header
 */
export function convertToMarkdown(content: string, options: ConvertToMarkdownOptions): string {
  const { url, charThreshold = 500, keepClasses = false } = options;

  // Parse HTML with linkedom (service worker compatible)
  const { document } = parseHTML(content);

  // Extract article content with Readability
  const reader = new Readability(document, {
    charThreshold,
    keepClasses,
    classesToPreserve: ['caption', 'citation'],
  });

  const article = reader.parse();

  if (!article || !article.content) {
    // Fallback: convert full document if Readability fails
    const bodyHtml = document.body?.innerHTML || content;
    const markdown = htmlToMarkdown(bodyHtml, document, {
      includeLinks: false,
      simpleTables: true,
    });

    return formatMarkdownWithMetadata({
      title: document.title || 'Untitled',
      url,
      markdown,
    });
  }

  // Convert extracted content to markdown
  const markdown = htmlToMarkdown(article.content, document, {
    includeLinks: false,
    simpleTables: true,
  });

  // Build metadata header
  return formatMarkdownWithMetadata({
    title: article.title || document.title || 'Untitled',
    byline: article.byline,
    publishedTime: article.publishedTime,
    siteName: article.siteName,
    url,
    markdown,
  });
}

interface MarkdownMetadata {
  title: string;
  url: string;
  markdown: string;
  byline?: string | null;
  publishedTime?: string | null;
  siteName?: string | null;
}

/**
 * Format markdown with metadata header for LLM context
 */
function formatMarkdownWithMetadata(meta: MarkdownMetadata): string {
  const lines: string[] = [`# ${meta.title}`];

  if (meta.byline) {
    lines.push(`*By ${meta.byline}*`);
  }

  if (meta.publishedTime) {
    lines.push(`*Published: ${meta.publishedTime}*`);
  }

  if (meta.siteName) {
    lines.push(`*Source: ${meta.siteName}*`);
  }

  lines.push(`*URL: ${meta.url}*`);
  lines.push('', '---', '', meta.markdown);

  return lines.join('\n');
}
