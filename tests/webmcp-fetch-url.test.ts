/**
 * Tests for agentboard_fetch_url system tool
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  fetchUrlTool,
  executeFetchUrl,
  FETCH_URL_TOOL_NAME,
} from '../src/lib/webmcp/tools/fetch/fetch-url';

describe('agentboard_fetch_url system tool', () => {
  beforeEach(() => {
    // Mock globalThis.fetch
    vi.clearAllMocks();
  });

  describe('tool definition', () => {
    it('exports AI SDK tool', () => {
      expect(fetchUrlTool).toBeDefined();
      expect(typeof fetchUrlTool).toBe('object');
    });

    it('has correct tool name constant', () => {
      expect(FETCH_URL_TOOL_NAME).toBe('agentboard_fetch_url');
    });

    it('exports execute function for testing', () => {
      expect(typeof executeFetchUrl).toBe('function');
    });
  });

  describe('content fetching', () => {
    it('returns raw HTML by default', async () => {
      const mockHtml = '<html><body>Hello</body></html>';

      // Mock fetch
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => mockHtml,
      });

      const result = await executeFetchUrl({
        url: 'https://example.com',
      });

      expect(result).toBe(mockHtml);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          credentials: 'include', // default
          headers: expect.objectContaining({
            'User-Agent': 'AgentBoard/0.1.0',
          }),
        })
      );
    });

    it('returns JSON as-is', async () => {
      const mockJson = '{"name": "test", "value": 123}';

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => mockJson,
      });

      const result = await executeFetchUrl({
        url: 'https://api.example.com/data.json',
      });

      expect(result).toBe(mockJson);
      expect(() => JSON.parse(result)).not.toThrow();
    });

    it('respects includeCredentials=false', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => 'content',
      });

      await executeFetchUrl({
        url: 'https://example.com',
        includeCredentials: false,
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          credentials: 'omit',
        })
      );
    });

    it('handles HTTP errors', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(executeFetchUrl({ url: 'https://example.com/missing' })).rejects.toThrow(
        'HTTP 404: Not Found'
      );
    });

    it('handles network errors', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      await expect(executeFetchUrl({ url: 'https://example.com' })).rejects.toThrow(
        'Failed to fetch'
      );
    });

    it('handles invalid URLs', async () => {
      await expect(executeFetchUrl({ url: 'not-a-url' })).rejects.toThrow();
    });
  });

  describe('markdown conversion', () => {
    it('converts HTML to markdown when requested', async () => {
      const mockHtml = `
        <html>
          <head><title>Test Article</title></head>
          <body>
            <article>
              <h1>Test Heading</h1>
              <p>This is a test paragraph.</p>
            </article>
          </body>
        </html>
      `;

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => mockHtml,
      });

      const result = await executeFetchUrl({
        url: 'https://example.com/article',
        convertToMarkdown: true,
      });

      // Should contain markdown formatting
      expect(result).toContain('#'); // Markdown heading
      expect(result).toContain('Test'); // Content
      expect(result).toContain('URL:'); // Metadata
      expect(result).not.toContain('<html>'); // No raw HTML
    });

    it('includes metadata in markdown output', async () => {
      const mockHtml = `
        <html>
          <head>
            <title>My Article</title>
            <meta property="og:site_name" content="Example Site">
          </head>
          <body><p>Content</p></body>
        </html>
      `;

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => mockHtml,
      });

      const result = await executeFetchUrl({
        url: 'https://example.com/article',
        convertToMarkdown: true,
      });

      expect(result).toContain('URL: https://example.com/article');
      expect(result).toContain('---'); // Separator
    });
  });

  describe('URL validation', () => {
    it('accepts http URLs', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => 'content',
      });

      await expect(executeFetchUrl({ url: 'http://example.com' })).resolves.toBeDefined();
    });

    it('accepts https URLs', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => 'content',
      });

      await expect(executeFetchUrl({ url: 'https://example.com' })).resolves.toBeDefined();
    });

    it('accepts localhost URLs', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => 'content',
      });

      await expect(executeFetchUrl({ url: 'http://localhost:3000' })).resolves.toBeDefined();
    });

    it('accepts private IP URLs', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => 'content',
      });

      await expect(executeFetchUrl({ url: 'http://192.168.1.1' })).resolves.toBeDefined();
    });
  });
});
