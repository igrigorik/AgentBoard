'use webmcp-tool v1';

export const metadata = {
  name: 'dom_query',
  namespace: 'agentboard',
  version: '1.0.0',
  description: 'Extract DOM elements from current tab using CSS selectors.',
  match: ['<all_urls>'],
  inputSchema: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'CSS selector to query elements'
      },
      attribute: {
        type: 'string',
        description: 'Specific attribute to extract from elements (optional)'
      },
      extractText: {
        type: 'boolean',
        description: 'Extract text content from elements'
      },
      extractHtml: {
        type: 'boolean',
        description: 'Extract inner HTML from elements'
      },
      limit: {
        type: 'number',
        description: 'Maximum number of elements to return',
        minimum: 1,
        maximum: 1000
      }
    },
    required: ['selector'],
    additionalProperties: false
  }
};

export async function execute(args) {
  if (!args.selector) {
    throw new Error('Selector is required');
  }

  const elements = document.querySelectorAll(args.selector);
  const limit = args.limit || 100;
  const results = [];

  for (let i = 0; i < Math.min(elements.length, limit); i++) {
    const element = elements[i];
    const item = {};

    // Add basic element info
    item.tagName = element.tagName.toLowerCase();
    item.id = element.id || undefined;
    item.className = element.className || undefined;

    // Extract specific attribute if requested
    if (args.attribute) {
      item.attribute = element.getAttribute(args.attribute);
    }

    // Extract text content if requested
    if (args.extractText) {
      item.text = element.textContent.trim();
    }

    // Extract HTML if requested
    if (args.extractHtml) {
      item.html = element.innerHTML;
    }

    // Add computed styles if element is visible
    const styles = window.getComputedStyle(element);
    item.visible = styles.display !== 'none' &&
      styles.visibility !== 'hidden' &&
      styles.opacity !== '0';

    // Add bounding rect for visible elements
    if (item.visible) {
      const rect = element.getBoundingClientRect();
      item.position = {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height
      };
    }

    results.push(item);
  }

  return {
    selector: args.selector,
    found: elements.length,
    returned: results.length,
    elements: results
  };
}
