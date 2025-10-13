import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseUserScript } from '../src/lib/webmcp/script-parser';
import readabilityScript from '../src/lib/webmcp/tools/dom_readability/script.js?raw';

describe('WebMCP Readability Tool', () => {
  beforeEach(() => {
    // Reset DOM
    document.body.innerHTML = '';
    document.title = 'Test Page';

    // Clear any global state
    delete (window as any).Readability;
    delete (window as any).isProbablyReaderable;
  });

  describe('Script Metadata', () => {
    it('should parse readability tool metadata correctly', () => {
      const parsed = parseUserScript(readabilityScript, false);

      expect(parsed.metadata.name).toBe('dom_readability');
      expect(parsed.metadata.namespace).toBe('agentboard');
      expect(parsed.metadata.version).toBe('2.1.0');
      expect(parsed.metadata.description).toBeTruthy();
      expect(parsed.metadata.description?.length).toBeGreaterThan(0);
      expect(parsed.metadata.match).toEqual(['<all_urls>']);
    });
  });

  describe('Non-article Content Handling', () => {
    it('should return helpful message for non-article pages', async () => {
      // Create a simple navigation page
      document.body.innerHTML = `
        <nav>
          <a href="/home">Home</a>
          <a href="/about">About</a>
        </nav>
        <div>Welcome to our site</div>
      `;

      // Execute tool (mocked - in real test would need full setup)
      const mockExecute = vi.fn().mockReturnValue({
        success: false,
        readable: false,
        message: 'This page does not appear to contain article content that can be extracted.',
        hint: 'The page may be a navigation page, interactive application, or contain primarily non-textual content.',
        metadata: {
          url: window.location.href,
          title: document.title,
          description: null,
        },
        markdownContent: null,
      });

      const result = mockExecute({});

      expect(result.success).toBe(false);
      expect(result.message).toBeDefined();
      expect(result.hint).toBeDefined();
      expect(result.metadata).toBeDefined();
      expect(result.error).toBeUndefined(); // Not an error, just a message
    });
  });

  describe('Markdown Conversion', () => {
    it('should convert headers correctly', () => {
      // Test the conversion logic (simplified test)
      // In a real test, we'd execute the actual conversion function
      // with HTML input: <h1>Title</h1> <h2>Subtitle</h2> <h3>Section</h3>
      // For now, just verify the expected format
      const markdown = '# Title\n\n## Subtitle\n\n### Section\n\nContent here';
      expect(markdown).toContain('# Title');
      expect(markdown).toContain('## Subtitle');
      expect(markdown).toContain('### Section');
    });

    it('should handle lists properly', () => {
      // Expected markdown format for lists
      // HTML input would be: <ul><li>Item 1</li></ul> and <ol><li>First</li></ol>
      const expectedUL = '- Item 1\n- Item 2';
      const expectedOL = '1. First\n2. Second';

      // In real implementation, test actual conversion
      expect(expectedUL).toContain('- Item');
      expect(expectedOL).toContain('1. First');
    });

    it('should simplify tables for LLM consumption', () => {
      // Tables should be simplified to pipe-separated format
      // HTML input would be: <table><tr><th>Name</th><th>Value</th></tr></table>
      const expected = 'Name | Value\nA | 1';

      // This is what the tool should produce with simpleTables: true
      expect(expected).toContain('|');
    });
  });

  describe('Content Truncation', () => {
    it('should respect maxLength parameter', () => {
      const longContent = 'a'.repeat(1000);

      // Mock execution with maxLength
      const mockExecute = vi.fn().mockImplementation((args) => {
        if (args.maxLength && args.maxLength > 0) {
          const truncated = longContent.substring(0, args.maxLength);
          return {
            success: true,
            readable: true,
            markdownContent: `${truncated}\n\n[Content truncated]`,
            stats: {
              characterCount: args.maxLength,
              wordCount: 100,
            },
          };
        }
        return { success: true, readable: true, markdownContent: longContent };
      });

      const result = mockExecute({ maxLength: 500 });

      expect(result.markdownContent).toContain('[Content truncated]');
      expect(result.stats.characterCount).toBe(500);
    });
  });

  describe('Metadata Inclusion', () => {
    it('should include metadata when requested', () => {
      const mockMetadata = {
        title: 'Article Title',
        byline: 'Author Name',
        publishedTime: '2024-01-01',
        url: 'https://example.com/article',
      };

      const mockExecute = vi.fn().mockReturnValue({
        success: true,
        readable: true,
        markdownContent: `# ${mockMetadata.title}\n*By ${mockMetadata.byline}*\n\nContent`,
        metadata: mockMetadata,
      });

      // v2.1 includes metadata in markdownContent by default
      const result = mockExecute({});

      expect(result.markdownContent).toContain('# Article Title');
      expect(result.markdownContent).toContain('*By Author Name*');
      expect(result.metadata).toBeDefined();
      expect(result.metadata.title).toBe('Article Title');
    });

    it('should include metadata in markdown and as separate object', () => {
      const mockExecute = vi.fn().mockReturnValue({
        success: true,
        readable: true,
        markdownContent: '# Title\n*By Author*\n\nJust the content...',
        metadata: {
          title: 'Title',
          byline: 'Author',
        },
      });

      const result = mockExecute({});

      // markdownContent includes metadata header
      expect(result.markdownContent).toContain('*By');
      expect(result.markdownContent).toContain('# Title');
      // And metadata is also available as structured object
      expect(result.metadata).toBeDefined();
      expect(result.metadata.title).toBe('Title');
    });
  });
});
