/**
 * Tests to ensure all README examples follow snake_case convention
 */

import { describe, it, expect } from 'vitest';
import { parseUserScript } from '../src/lib/webmcp/script-parser';

describe('README Examples Validation', () => {
  it('should validate extract_links example', () => {
    const script = `'use webmcp-tool v1';

export const metadata = {
  name: "extract_links",
  namespace: "my_tools",
  version: "1.0.0", 
  description: "Extract all links from the current page",
  match: "<all_urls>",
  inputSchema: {
    type: "object",
    properties: {
      selector: { 
        type: "string",
        description: "CSS selector to filter links (optional)"
      }
    },
    additionalProperties: false
  }
};

export async function execute(args) {
  const selector = args.selector || 'a[href]';
  const links = Array.from(document.querySelectorAll(selector))
    .map(a => ({ text: a.textContent, url: a.href }))
    .slice(0, 20);
  
  return {
    content: [{
      type: 'json',
      json: { links, count: links.length }
    }]
  };
}`;

    const result = parseUserScript(script);
    expect(result.metadata.name).toBe('extract_links');
    expect(result.metadata.namespace).toBe('my_tools');
  });

  it('should validate page_metadata example', () => {
    const script = `'use webmcp-tool v1';

export const metadata = {
  name: "page_metadata",
  namespace: "examples",
  version: "1.0.0",
  description: "Extract comprehensive page metadata",
  match: "<all_urls>"
};

export async function execute() {
  const meta = {};
  return { content: [{ type: 'json', json: meta }] };
}`;

    const result = parseUserScript(script);
    expect(result.metadata.name).toBe('page_metadata');
    expect(result.metadata.namespace).toBe('examples');
  });

  it('should validate form_assistant example', () => {
    const script = `'use webmcp-tool v1';

export const metadata = {
  name: "form_assistant",
  namespace: "examples", 
  version: "1.0.0",
  description: "Analyze and fill forms on the page",
  match: ["https://*/*", "http://*/*"],
  inputSchema: {
    type: "object",
    properties: {
      action: { enum: ["analyze", "fill"] },
      data: { type: "object", description: "Form data to fill" }
    },
    required: ["action"]
  }
};

export async function execute(args) {
  if (args.action === 'analyze') {
    return { content: [{ type: 'json', json: { forms: [], count: 0 } }] };
  }
  return 'Form fields filled successfully';
}`;

    const result = parseUserScript(script);
    expect(result.metadata.name).toBe('form_assistant');
    expect(result.metadata.namespace).toBe('examples');
  });

  it('should validate content_scraper example', () => {
    const script = `'use webmcp-tool v1';

export const metadata = {
  name: "content_scraper",
  namespace: "examples",
  version: "1.0.0",
  description: "Extract structured content from the page",
  match: "<all_urls>",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector" },
      attribute: { type: "string", description: "Attribute to extract" },
      limit: { type: "number", default: 10, maximum: 50 }
    },
    required: ["selector"]
  }
};

export async function execute(args) {
  const elements = document.querySelectorAll(args.selector);
  const limit = args.limit || 10;
  const results = [];
  
  return {
    content: [{
      type: 'json',
      json: {
        selector: args.selector,
        found: elements.length,
        returned: results.length,
        results
      }
    }]
  };
}`;

    const result = parseUserScript(script);
    expect(result.metadata.name).toBe('content_scraper');
    expect(result.metadata.namespace).toBe('examples');
  });

  it('should reject hyphenated names from old examples', () => {
    // This ensures we never regress back to hyphenated names
    const badScript = `'use webmcp-tool v1';

export const metadata = {
  name: "page-metadata", // Should be page_metadata
  namespace: "examples",
  version: "1.0.0",
  description: "Test",
  match: "<all_urls>"
};

export async function execute() {
  return "test";
}`;

    expect(() => parseUserScript(badScript)).toThrow(/snake_case/);
  });
});
