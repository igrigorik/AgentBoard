/**
 * Tests for WebMCP script editor error feedback
 */

import { describe, it, expect } from 'vitest';
import { parseUserScript, ScriptParsingError } from '../src/lib/webmcp/script-parser';

describe('WebMCP Script Editor Error Feedback', () => {
  it('should throw error for non-snake_case names', () => {
    const script = `'use webmcp-tool v1';
    
export const metadata = {
  name: "myTool", // camelCase instead of snake_case
  namespace: "custom",
  version: "1.0.0", 
  match: "<all_urls>"
};

export async function execute(args) {
  return "test";
}`;

    expect(() => parseUserScript(script)).toThrow(ScriptParsingError);
    expect(() => parseUserScript(script)).toThrow(/snake_case/);
  });

  it('should throw error for non-snake_case namespace', () => {
    const script = `'use webmcp-tool v1';
    
export const metadata = {
  name: "my_tool",
  namespace: "customNamespace", // camelCase instead of snake_case
  version: "1.0.0",
  match: "<all_urls>"
};

export async function execute(args) {
  return "test";
}`;

    expect(() => parseUserScript(script)).toThrow(ScriptParsingError);
    expect(() => parseUserScript(script)).toThrow(/Namespace must be snake_case/);
  });

  it('should accept valid snake_case names', () => {
    const script = `'use webmcp-tool v1';
    
export const metadata = {
  name: "my_tool",
  namespace: "custom_namespace", 
  version: "1.0.0",
  description: "A valid tool",
  match: "<all_urls>"
};

export async function execute(args) {
  return "test";
}`;

    const result = parseUserScript(script);
    expect(result.metadata.name).toBe('my_tool');
    expect(result.metadata.namespace).toBe('custom_namespace');
  });

  it('should provide specific error for hyphenated names', () => {
    const script = `'use webmcp-tool v1';
    
export const metadata = {
  name: "my-tool", // hyphenated instead of snake_case
  namespace: "custom",
  version: "1.0.0",
  match: "<all_urls>"
};

export async function execute(args) {
  return "test";
}`;

    expect(() => parseUserScript(script)).toThrow(/snake_case/);
  });

  it('should provide clear error for missing metadata', () => {
    const script = `'use webmcp-tool v1';
    
export async function execute(args) {
  return "test";
}`;

    expect(() => parseUserScript(script)).toThrow(/Missing export: metadata/);
  });

  it('should provide clear error for missing execute function', () => {
    const script = `'use webmcp-tool v1';
    
export const metadata = {
  name: "my_tool",
  namespace: "custom",
  version: "1.0.0",
  match: "<all_urls>"
};`;

    expect(() => parseUserScript(script)).toThrow(/Missing export: execute function/);
  });

  it('should provide error for reserved namespace', () => {
    const script = `'use webmcp-tool v1';
    
export const metadata = {
  name: "my_tool",
  namespace: "agentboard", // reserved namespace
  version: "1.0.0",
  match: "<all_urls>"
};

export async function execute(args) {
  return "test";
}`;

    expect(() => parseUserScript(script, true)).toThrow(/Reserved namespace: agentboard/);
  });

  it('should have valid snake_case in default template', () => {
    // This is a copy of the template from webmcp-scripts.ts
    // Ensures the template always remains valid
    const templateScript = `'use webmcp-tool v1';

export const metadata = {
  name: "my_tool",
  namespace: "custom",
  version: "0.1.0",
  description: "Description of what this tool does",
  match: "<all_urls>",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" }
    },
    required: ["query"],
    additionalProperties: false
  }
};

export async function execute(args) {
  return \`Processed: \${args.query}\`;
}`;

    // Should parse without errors
    const result = parseUserScript(templateScript);
    expect(result.metadata.name).toBe('my_tool');
    expect(result.metadata.namespace).toBe('custom');
    expect(result).toBeDefined();
  });
});
