/**
 * Tests for agentboard_fetch_url system tool
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as contentExtractor from '../src/lib/webmcp/tools/fetch/content-extractor';
import {
  fetchUrlTool,
  fetchUrlOutputSchema,
  executeFetchUrl,
  FETCH_URL_METADATA,
  FETCH_URL_TOOL_NAME,
} from '../src/lib/webmcp/tools/fetch/fetch-url';

function httpResponse(
  content: string,
  {
    status = 200,
    statusText = status === 200 ? 'OK' : '',
    responseUrl = '',
  }: { status?: number; statusText?: string; responseUrl?: string } = {}
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    url: responseUrl,
    headers: new Headers({ 'Content-Type': 'text/plain' }),
    text: async () => content,
  } as Response;
}

async function expectValueFreeFetchFailure(request: Promise<unknown>): Promise<void> {
  await expect(request).rejects.toHaveProperty('message', 'URL fetch failed');
}

describe('agentboard_fetch_url system tool', () => {
  beforeEach(() => {
    // Mock globalThis.fetch
    vi.clearAllMocks();
  });

  describe('tool definition', () => {
    it('exports AI SDK tool with a structured output contract', () => {
      expect(fetchUrlTool).toBeDefined();
      expect(typeof fetchUrlTool).toBe('object');
      expect(fetchUrlTool.outputSchema).toBeDefined();
    });

    it('accepts the Fetch status range and rejects invalid status values', () => {
      for (const status of [0, 200, 600, 999]) {
        expect(fetchUrlOutputSchema.safeParse({ status, content: '' }).success).toBe(true);
      }
      expect(fetchUrlOutputSchema.safeParse({ status: -1, content: '' }).success).toBe(false);
      expect(fetchUrlOutputSchema.safeParse({ status: 1000, content: '' }).success).toBe(false);
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

      global.fetch = vi.fn().mockResolvedValue(httpResponse(mockHtml));

      const result = await executeFetchUrl({
        url: 'https://example.com',
      });

      expect(result).toStrictEqual({
        status: 200,
        statusText: 'OK',
        content: mockHtml,
      });
      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          credentials: 'omit', // privacy-preserving default
          headers: expect.objectContaining({
            'User-Agent': 'AgentBoard/0.1.0',
          }),
        })
      );
    });

    it('returns JSON as-is', async () => {
      const mockJson = '{"name": "test", "value": 123}';

      global.fetch = vi.fn().mockResolvedValue(httpResponse(mockJson));

      const result = await executeFetchUrl({
        url: 'https://api.example.com/data.json',
      });

      expect(result).toEqual({
        status: 200,
        statusText: 'OK',
        content: mockJson,
      });
      expect(() => JSON.parse(result.content)).not.toThrow();
    });

    it('does not expose a model-controlled credential mode', () => {
      expect(FETCH_URL_METADATA.inputSchema.properties).not.toHaveProperty('includeCredentials');
    });

    it('rechecks enablement before a captured tool can fetch', async () => {
      vi.mocked(chrome.storage.local.get).mockResolvedValueOnce({
        config: {
          schemaVersion: 2,
          agents: [],
          builtinScripts: [{ id: FETCH_URL_TOOL_NAME, enabled: false }],
        },
      } as never);
      global.fetch = vi.fn();

      await expectValueFreeFetchFailure(executeFetchUrl({ url: 'https://example.com' }));
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('forwards stream cancellation to fetch', async () => {
      let requestSignal: AbortSignal | undefined;
      global.fetch = vi.fn((_url, options): Promise<Response> => {
        const signal = options?.signal as AbortSignal;
        requestSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });
      const controller = new AbortController();

      const request = executeFetchUrl(
        { url: 'https://example.com' },
        { abortSignal: controller.signal }
      );
      await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledOnce());
      controller.abort();

      await expectValueFreeFetchFailure(request);
      expect(requestSignal).toBe(controller.signal);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({ credentials: 'omit', signal: controller.signal })
      );
    });

    it('cancels while a completed response body is still pending', async () => {
      let resolveBody!: (content: string) => void;
      const body = new Promise<string>((resolve) => {
        resolveBody = resolve;
      });
      const response = httpResponse('');
      response.text = vi.fn(() => body);
      global.fetch = vi.fn().mockResolvedValue(response);
      const controller = new AbortController();

      const request = executeFetchUrl(
        { url: 'https://example.com' },
        { abortSignal: controller.signal }
      );
      await vi.waitFor(() => expect(response.text).toHaveBeenCalledOnce());
      controller.abort();

      await expectValueFreeFetchFailure(request);
      resolveBody('late body');
    });

    it('fails with a value-free error when the response body cannot be read', async () => {
      const response = httpResponse('');
      response.text = vi.fn().mockRejectedValue(new Error('private body failure'));
      global.fetch = vi.fn().mockResolvedValue(response);

      await expectValueFreeFetchFailure(executeFetchUrl({ url: 'https://example.com' }));
    });

    it('returns non-2xx status and raw response content as a successful tool result', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        httpResponse('Try the members page instead.', {
          status: 404,
          statusText: 'Not Found',
          responseUrl: 'https://example.com/not-here',
        })
      );

      await expect(executeFetchUrl({ url: 'https://example.com/missing' })).resolves.toStrictEqual({
        status: 404,
        statusText: 'Not Found',
        content: 'Try the members page instead.',
      });
    });

    it('preserves an empty non-2xx body when markdown conversion is requested', async () => {
      global.fetch = vi.fn().mockResolvedValue(httpResponse('', { status: 503 }));

      await expect(
        executeFetchUrl({
          url: 'https://example.com/unavailable',
          convertToMarkdown: true,
        })
      ).resolves.toEqual({
        status: 503,
        content: '',
      });
    });

    it('handles network errors', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      await expectValueFreeFetchFailure(executeFetchUrl({ url: 'https://example.com' }));
    });

    it('handles invalid URLs', async () => {
      await expectValueFreeFetchFailure(executeFetchUrl({ url: 'not-a-url' }));
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

      global.fetch = vi.fn().mockResolvedValue(httpResponse(mockHtml));

      const result = await executeFetchUrl({
        url: 'https://example.com/article',
        convertToMarkdown: true,
      });

      expect(result.status).toBe(200);
      expect(result.content).toContain('#'); // Markdown heading
      expect(result.content).toContain('Test'); // Content
      expect(result.content).toContain('URL:'); // Metadata
      expect(result.content).not.toContain('<html>'); // No raw HTML
    });

    it('fails with a value-free error when markdown extraction fails', async () => {
      global.fetch = vi.fn().mockResolvedValue(httpResponse('<html><body>Content</body></html>'));
      const conversion = vi
        .spyOn(contentExtractor, 'convertToMarkdown')
        .mockImplementationOnce(() => {
          throw new Error('private extraction failure');
        });

      try {
        await expectValueFreeFetchFailure(
          executeFetchUrl({
            url: 'https://example.com/article',
            convertToMarkdown: true,
          })
        );
      } finally {
        conversion.mockRestore();
      }
    });

    it('honors cancellation raised during synchronous markdown extraction', async () => {
      global.fetch = vi.fn().mockResolvedValue(httpResponse('<html><body>Content</body></html>'));
      const controller = new AbortController();
      const conversion = vi
        .spyOn(contentExtractor, 'convertToMarkdown')
        .mockImplementationOnce(() => {
          controller.abort();
          return 'late markdown';
        });

      try {
        await expectValueFreeFetchFailure(
          executeFetchUrl(
            {
              url: 'https://example.com/article',
              convertToMarkdown: true,
            },
            { abortSignal: controller.signal }
          )
        );
      } finally {
        conversion.mockRestore();
      }
    });

    it('extracts useful markdown from a non-2xx response and preserves its status', async () => {
      const errorHtml = `
        <html>
          <head><title>Page moved</title></head>
          <body>
            <main>
              <h1>We could not find that page</h1>
              <p>The current membership information is available on the members page.</p>
            </main>
          </body>
        </html>
      `;

      global.fetch = vi.fn().mockResolvedValue(
        httpResponse(errorHtml, {
          status: 404,
          statusText: 'Not Found',
          responseUrl: 'https://example.com/new-location',
        })
      );

      const result = await executeFetchUrl({
        url: 'https://example.com/old-location',
        convertToMarkdown: true,
      });

      expect(result.status).toBe(404);
      expect(result.statusText).toBe('Not Found');
      expect(result.content).toContain('URL: https://example.com/old-location');
      expect(result.content).not.toContain('https://example.com/new-location');
      expect(result.content).toContain('membership information is available');
      expect(result.content).not.toContain('<html>');
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

      global.fetch = vi.fn().mockResolvedValue(httpResponse(mockHtml));

      const result = await executeFetchUrl({
        url: 'https://example.com/article',
        convertToMarkdown: true,
      });

      expect(result.content).toContain('URL: https://example.com/article');
      expect(result.content).toContain('---'); // Separator
    });
  });

  describe('URL validation', () => {
    it('rejects HTTP origins outside localhost before fetching', async () => {
      global.fetch = vi.fn();

      await expectValueFreeFetchFailure(executeFetchUrl({ url: 'http://example.com' }));
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('accepts https URLs', async () => {
      global.fetch = vi.fn().mockResolvedValue(httpResponse('content'));

      await expect(executeFetchUrl({ url: 'https://example.com' })).resolves.toEqual({
        status: 200,
        statusText: 'OK',
        content: 'content',
      });
    });

    it('accepts localhost URLs', async () => {
      global.fetch = vi.fn().mockResolvedValue(httpResponse('content'));

      await expect(executeFetchUrl({ url: 'http://localhost:3000' })).resolves.toBeDefined();
    });

    it('accepts private IP URLs over HTTPS', async () => {
      global.fetch = vi.fn().mockResolvedValue(httpResponse('content'));

      await expect(executeFetchUrl({ url: 'https://192.168.1.1' })).resolves.toBeDefined();
    });
  });
});
