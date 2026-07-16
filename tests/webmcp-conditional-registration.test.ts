import { describe, it, expect } from 'vitest';
import { parseUserScript } from '../src/lib/webmcp/script-parser';

describe('WebMCP Conditional Registration', () => {
  describe('Script Parser', () => {
    it('should parse script with shouldRegister export', () => {
      const scriptCode = `
'use webmcp-tool v1';

export const metadata = {
  name: 'conditional_tool',
  namespace: 'test',
  version: '1.0.0',
  match: ['<all_urls>']
};

export function shouldRegister() {
  return window.someCondition === true;
}

export async function execute(args) {
  return 'executed';
}`;

      const parsed = parseUserScript(scriptCode);
      expect(parsed.metadata.name).toBe('conditional_tool');
      expect(parsed.code).toContain('shouldRegister');
    });

    it('should parse script without shouldRegister export', () => {
      const scriptCode = `
'use webmcp-tool v1';

export const metadata = {
  name: 'normal_tool',
  namespace: 'test',
  version: '1.0.0',
  match: ['<all_urls>']
};

export async function execute(args) {
  return 'executed';
}`;

      const parsed = parseUserScript(scriptCode);
      expect(parsed.metadata.name).toBe('normal_tool');
      expect(parsed.code).not.toContain('export function shouldRegister');
    });

    it('should reject async shouldRegister', () => {
      const scriptCode = `
'use webmcp-tool v1';

export const metadata = {
  name: 'bad_tool',
  namespace: 'test',
  version: '1.0.0',
  match: ['<all_urls>']
};

export async function shouldRegister() {
  return true;
}

export async function execute(args) {
  return 'executed';
}`;

      expect(() => parseUserScript(scriptCode)).toThrow(
        'shouldRegister must be synchronous (not async)'
      );
    });
  });
});
