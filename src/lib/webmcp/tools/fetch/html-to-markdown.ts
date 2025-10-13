/**
 * Convert HTML to Markdown optimized for LLM consumption
 * Context-agnostic: works with native DOM or linkedom in service worker
 *
 * Extracted from dom_readability tool and adapted for reuse.
 * Prioritizes structure and readability over formatting fidelity.
 */

export interface HtmlToMarkdownOptions {
  includeLinks?: boolean;
  simpleTables?: boolean;
}

/**
 * Convert HTML string to markdown using provided document context
 * @param html - HTML content to convert
 * @param doc - Document object (native or linkedom)
 * @param options - Conversion options
 */
export function htmlToMarkdown(
  html: string,
  doc: Document,
  options: HtmlToMarkdownOptions = {}
): string {
  const container = doc.createElement('div');
  container.innerHTML = html;

  function processNode(node: Node, depth = 0): string {
    if (node.nodeType === 3) {
      // TEXT_NODE
      // Clean up whitespace but preserve intentional spacing
      return node.textContent?.replace(/\s+/g, ' ').trim() || '';
    }

    if (node.nodeType !== 1) {
      // ELEMENT_NODE
      return '';
    }

    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    const children = Array.from(element.childNodes)
      .map((child) => processNode(child, depth + 1))
      .filter((text) => text)
      .join('');

    switch (tag) {
      // Headers - preserve hierarchy
      case 'h1':
        return `\n\n# ${children}\n`;
      case 'h2':
        return `\n\n## ${children}\n`;
      case 'h3':
        return `\n\n### ${children}\n`;
      case 'h4':
        return `\n\n#### ${children}\n`;
      case 'h5':
        return `\n\n##### ${children}\n`;
      case 'h6':
        return `\n\n###### ${children}\n`;

      // Paragraphs
      case 'p':
        return children ? `\n\n${children}` : '';

      // Emphasis
      case 'strong':
      case 'b':
        return children ? `**${children}**` : '';

      case 'em':
      case 'i':
        return children ? `*${children}*` : '';

      // Code
      case 'code':
        // Check if it's inside a pre tag
        if (element.parentElement && element.parentElement.tagName.toLowerCase() === 'pre') {
          return children;
        }
        return children ? `\`${children}\`` : '';

      case 'pre': {
        const codeContent = children.replace(/^\n+|\n+$/g, '');
        return `\n\n\`\`\`\n${codeContent}\n\`\`\`\n`;
      }

      // Quotes
      case 'blockquote':
        if (!children) return '';
        return `\n\n${children
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => `> ${line}`)
          .join('\n')}`;

      // Links
      case 'a':
        if (options.includeLinks) {
          const href = element.getAttribute('href');
          if (href && !href.startsWith('javascript:')) {
            return `[${children}](${href})`;
          }
        }
        return children;

      // Lists
      case 'ul':
        return `\n\n${Array.from(element.children)
          .filter((child) => child.tagName.toLowerCase() === 'li')
          .map((li) => `- ${processNode(li, depth + 1)}`)
          .join('\n')}`;

      case 'ol':
        return `\n\n${Array.from(element.children)
          .filter((child) => child.tagName.toLowerCase() === 'li')
          .map((li, index) => `${index + 1}. ${processNode(li, depth + 1)}`)
          .join('\n')}`;

      case 'li':
        // Content already handled by parent ul/ol
        return children;

      // Breaks
      case 'br':
        return '\n';

      case 'hr':
        return '\n\n---\n';

      // Images
      case 'img': {
        const alt = element.getAttribute('alt') || 'image';
        const src = element.getAttribute('src');
        if (options.includeLinks && src) {
          return `![${alt}](${src})`;
        }
        return `[${alt}]`;
      }

      // Tables
      case 'table': {
        if (options.simpleTables) {
          // Simplified table representation for LLMs
          const rows = Array.from(element.querySelectorAll('tr'));
          if (rows.length === 0) return '';

          const tableText = rows
            .map((row) => {
              const cells = Array.from(row.querySelectorAll('td, th'))
                .map((cell) => processNode(cell, depth + 1))
                .filter((text) => text);
              return cells.join(' | ');
            })
            .filter((row) => row)
            .join('\n');

          return tableText ? `\n\n${tableText}\n` : '';
        }
        return '\n\n[Table content]\n';
      }

      // Skip these but process children
      case 'div':
      case 'article':
      case 'section':
      case 'span':
      case 'tbody':
      case 'thead':
      case 'tfoot':
        return children;

      // Skip these elements entirely
      case 'script':
      case 'style':
      case 'noscript':
        return '';

      default:
        return children;
    }
  }

  let markdown = processNode(container);

  // Clean up excessive whitespace
  markdown = markdown
    .replace(/\n{4,}/g, '\n\n\n') // Max 3 newlines
    .replace(/^\n+|\n+$/g, '') // Trim start/end
    .replace(/[ \t]+$/gm, '') // Remove trailing spaces
    .trim();

  return markdown;
}
