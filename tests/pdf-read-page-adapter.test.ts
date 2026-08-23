import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadPageTool, type ReadPageInput } from '../src/lib/webmcp/tools/read_page';
import type { PdfHostMessage, PdfReadResult } from '../src/lib/webmcp/tools/read_page/pdf/protocol';

const mocks = vi.hoisted(() => ({
  getOwnedDocument: vi.fn(),
  ownsDocument: vi.fn(),
  isBuiltinToolEnabled: vi.fn(),
}));

vi.mock('../src/lib/webmcp/lifecycle', () => ({
  getTabManager: () => ({
    getOwnedDocument: mocks.getOwnedDocument,
    ownsDocument: mocks.ownsDocument,
  }),
}));

vi.mock('../src/lib/storage/config', () => ({
  ConfigStorage: {
    getInstance: () => ({ isBuiltinToolEnabled: mocks.isBuiltinToolEnabled }),
  },
}));

vi.mock('../src/lib/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function toolCallOptions(abortSignal?: AbortSignal) {
  return { toolCallId: 'test-call', messages: [], abortSignal };
}

interface FakePort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener(listener: (message: PdfHostMessage) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

function fakePdfPort(result?: PdfReadResult): FakePort {
  const messageListeners: Array<(message: PdfHostMessage) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const port: FakePort = {
    name: 'agentboard-pdf-reader:test',
    postMessage: vi.fn((message: { type?: string }) => {
      if (message.type === 'start' && result) {
        queueMicrotask(() => {
          for (const listener of messageListeners) listener({ type: 'result', result });
        });
      }
    }),
    disconnect: vi.fn(() => {
      for (const listener of disconnectListeners) listener();
    }),
    onMessage: { addListener: (listener) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
  };
  setTimeout(() => {
    for (const listener of messageListeners) listener({ type: 'ready' });
  }, 0);
  return port;
}

const htmlResult = {
  success: true as const,
  extractionMode: 'article' as const,
  metadata: {
    title: 'Fixture',
    url: 'https://example.test/article',
    author: null,
    siteName: null,
    publishedTime: null,
    modifiedTime: null,
    language: 'en',
    direction: 'ltr',
    extractedAt: '2026-01-01T00:00:00.000Z',
  },
  markdownContent: '# Fixture',
  truncated: false,
  stats: { characterCount: 9, wordCount: 2, estimatedReadTime: 1 },
};

const pdfResult: PdfReadResult = {
  success: true,
  extractionMode: 'pdf',
  metadata: {
    title: 'Fixture',
    url: 'https://example.test/document.pdf',
    author: null,
    siteName: null,
    publishedTime: null,
    modifiedTime: null,
    language: 'und',
    direction: 'ltr',
    extractedAt: '2026-01-01T00:00:00.000Z',
  },
  markdownContent: '# PDF: Fixture',
  truncated: false,
  warnings: [],
  pdf: {
    pageCount: 1,
    startPage: 1,
    endPage: 1,
    nextPage: null,
    layoutMode: 'layout',
  },
  stats: {
    characterCount: 14,
    wordCount: 3,
    estimatedReadTime: 1,
    extractedPageCount: 1,
  },
};

describe('read-page document router', () => {
  beforeEach(() => {
    mocks.getOwnedDocument.mockReturnValue({ documentId: 'doc-1' });
    mocks.ownsDocument.mockReturnValue(true);
    mocks.isBuiltinToolEnabled.mockResolvedValue(true);
  });

  it('routes HTML through the private exact-document host without PDF-only arguments', async () => {
    const executeScript = vi.fn(async (details: { args?: unknown[]; files?: string[] }) => {
      if (details.files) return [{ documentId: 'doc-1', frameId: 0 }];
      if (details.args) {
        return [{ documentId: 'doc-1', frameId: 0, result: htmlResult }];
      }
      return [{ documentId: 'doc-1', frameId: 0, result: 'text/html' }];
    });
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn() },
    });
    const tool = createReadPageTool(7);
    const input: ReadPageInput = { maxLength: 4_000, startPage: 3, maxPages: 2 };
    const executionOptions = toolCallOptions(new AbortController().signal);

    await expect(tool.execute?.(input, executionOptions)).resolves.toEqual(htmlResult);
    expect(executeScript).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: { tabId: 7, documentIds: ['doc-1'] },
        world: 'ISOLATED',
        files: ['content-scripts/read-page-html-host.js'],
      })
    );
    expect(executeScript).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        target: { tabId: 7, documentIds: ['doc-1'] },
        world: 'ISOLATED',
        args: ['__agentboardReadPageHtmlV1', 1, { maxLength: 4_000 }],
      })
    );
  });

  it.each([undefined, 'application/pdf; definitely-not-a-parameter'])(
    'fails closed when document-type probing returns an invalid browser-owned value',
    async (contentType) => {
      vi.stubGlobal('chrome', {
        scripting: {
          executeScript: vi.fn(async () => [
            { documentId: 'doc-1', frameId: 0, result: contentType },
          ]),
        },
        tabs: { connect: vi.fn() },
      });

      await expect(createReadPageTool(7).execute?.({}, toolCallOptions())).resolves.toEqual({
        success: false,
        error: { code: 'PARSE_FAILED', message: 'The document type could not be determined.' },
      });
    }
  );

  it('rejects a malformed result from the private HTML host', async () => {
    const executeScript = vi.fn(async (details: { args?: unknown[]; files?: string[] }) => {
      if (details.files) return [{ documentId: 'doc-1', frameId: 0 }];
      if (details.args) return [{ documentId: 'doc-1', frameId: 0, result: { success: true } }];
      return [{ documentId: 'doc-1', frameId: 0, result: 'text/html' }];
    });
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn() },
    });

    await expect(createReadPageTool(7).execute?.({}, toolCallOptions())).rejects.toThrow(
      'HTML reader returned an invalid result'
    );
  });

  it('rejects an HTML result that crosses its settlement deadline', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    const executeScript = vi.fn(async (details: { args?: unknown[]; files?: string[] }) => {
      if (details.files) return [{ documentId: 'doc-1', frameId: 0 }];
      if (details.args) {
        now.mockReturnValue(10_000);
        return [{ documentId: 'doc-1', frameId: 0, result: htmlResult }];
      }
      return [{ documentId: 'doc-1', frameId: 0, result: 'text/html' }];
    });
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn() },
    });

    try {
      await expect(createReadPageTool(7).execute?.({}, toolCallOptions())).resolves.toEqual({
        success: false,
        error: { code: 'TIMEOUT', message: 'HTML extraction exceeded its time limit.' },
      });
    } finally {
      now.mockRestore();
    }
  });

  it('fences caller cancellation without pretending to stop a running browser script', async () => {
    let releaseExtraction!: (results: chrome.scripting.InjectionResult<unknown>[]) => void;
    const extraction = new Promise<chrome.scripting.InjectionResult<unknown>[]>((resolve) => {
      releaseExtraction = resolve;
    });
    const executeScript = vi.fn((details: { args?: unknown[]; files?: string[] }) => {
      if (details.files) return Promise.resolve([{ documentId: 'doc-1', frameId: 0 }]);
      if (details.args) return extraction;
      return Promise.resolve([{ documentId: 'doc-1', frameId: 0, result: 'text/html' }]);
    });
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn() },
    });
    const controller = new AbortController();
    const reason = new DOMException('caller cancelled', 'AbortError');
    let settled = false;
    const execute = createReadPageTool(7).execute;
    if (!execute) throw new Error('read_page execute function is unavailable');
    const result = Promise.resolve(execute({}, toolCallOptions(controller.signal))).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(3));
    controller.abort(reason);
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseExtraction([{ documentId: 'doc-1', frameId: 0, result: htmlResult }]);
    await expect(result).rejects.toBe(reason);
  });

  it('runs the exact-document PDF host and never calls the HTML delegate', async () => {
    const port = fakePdfPort(pdfResult);
    const executeScript = vi.fn(async (details: { func?: unknown }) => [
      {
        documentId: 'doc-1',
        frameId: 0,
        result: details.func ? 'application/pdf' : undefined,
      },
    ]);
    const connect = vi.fn(() => port);
    vi.stubGlobal('chrome', { scripting: { executeScript }, tabs: { connect } });
    const tool = createReadPageTool(7);

    await expect(
      tool.execute?.({ maxLength: 32_000.75, startPage: 2, maxPages: 50 }, toolCallOptions())
    ).resolves.toEqual(pdfResult);
    expect(executeScript).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ target: { tabId: 7, documentIds: ['doc-1'] } })
    );
    expect(executeScript).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: { tabId: 7, documentIds: ['doc-1'] },
        files: ['content-scripts/pdf-document-host.js'],
      })
    );
    expect(connect).toHaveBeenCalledWith(7, expect.objectContaining({ documentId: 'doc-1' }));
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'start',
      capability: expect.any(String),
      options: { maxLength: 32_000, startPage: 2, maxPages: 50 },
    });
  });

  it('uses the 25-page default for PDF calls', async () => {
    const port = fakePdfPort(pdfResult);
    const executeScript = vi.fn(async (details: { func?: unknown }) => [
      {
        documentId: 'doc-1',
        frameId: 0,
        result: details.func ? 'application/pdf' : undefined,
      },
    ]);
    const connect = vi.fn(() => port);
    vi.stubGlobal('chrome', { scripting: { executeScript }, tabs: { connect } });

    await expect(createReadPageTool(7).execute?.({}, toolCallOptions())).resolves.toEqual(
      pdfResult
    );
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'start',
      capability: expect.any(String),
      options: { maxLength: 32_000, startPage: 1, maxPages: 25 },
    });
  });

  it.each([null, { maxPages: 51 }])(
    'rejects malformed direct input before browser work',
    async (input) => {
      const executeScript = vi.fn();
      vi.stubGlobal('chrome', {
        scripting: { executeScript },
        tabs: { connect: vi.fn() },
      });
      const tool = createReadPageTool(7);

      await expect(tool.execute?.(input as never, toolCallOptions())).rejects.toThrow(
        'WebMCP tool arguments are invalid'
      );
      expect(executeScript).not.toHaveBeenCalled();
    }
  );

  it('fails closed when the HTML host settles after its document route is replaced', async () => {
    mocks.ownsDocument.mockReturnValue(false);
    const executeScript = vi.fn(async (details: { args?: unknown[]; files?: string[] }) => {
      if (details.files) return [{ documentId: 'doc-1', frameId: 0 }];
      if (details.args) {
        return [{ documentId: 'doc-1', frameId: 0, result: htmlResult }];
      }
      return [{ documentId: 'doc-1', frameId: 0, result: 'text/html' }];
    });
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn() },
    });
    const tool = createReadPageTool(7);

    await expect(tool.execute?.({}, toolCallOptions())).resolves.toMatchObject({
      success: false,
      error: { code: 'NAVIGATED' },
    });
  });

  it('times out while document-type detection is still pending', async () => {
    vi.useFakeTimers();
    const executeScript = vi.fn(() => new Promise(() => undefined));
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn() },
    });
    const tool = createReadPageTool(7);

    try {
      const result = tool.execute?.({}, toolCallOptions());
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(result).resolves.toEqual({
        success: false,
        error: { code: 'TIMEOUT', message: 'Document type detection exceeded its time limit.' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out while the exact-document host is still being injected', async () => {
    vi.useFakeTimers();
    const executeScript = vi
      .fn()
      .mockResolvedValueOnce([{ documentId: 'doc-1', frameId: 0, result: 'application/pdf' }])
      .mockReturnValueOnce(new Promise(() => undefined));
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn() },
    });
    const tool = createReadPageTool(7);

    try {
      const result = tool.execute?.({}, toolCallOptions());
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(result).resolves.toEqual({
        success: false,
        error: { code: 'TIMEOUT', message: 'PDF extraction exceeded its time limit.' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports packaged PDF host injection failure without inventing navigation', async () => {
    const executeScript = vi
      .fn()
      .mockResolvedValueOnce([{ documentId: 'doc-1', frameId: 0, result: 'application/pdf' }])
      .mockRejectedValueOnce(new Error('packaged host unavailable'));
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn() },
    });

    await expect(createReadPageTool(7).execute?.({}, toolCallOptions())).resolves.toEqual({
      success: false,
      error: { code: 'PDF_READER_REQUIRED', message: 'The local PDF reader is unavailable.' },
    });
  });

  it('reports a current-document PDF Port loss without inventing navigation', async () => {
    const port = fakePdfPort();
    vi.stubGlobal('chrome', {
      scripting: {
        executeScript: vi.fn(async (details: { func?: unknown }) => [
          {
            documentId: 'doc-1',
            frameId: 0,
            result: details.func ? 'application/pdf' : undefined,
          },
        ]),
      },
      tabs: { connect: vi.fn(() => port) },
    });
    const execution = createReadPageTool(7).execute?.({}, toolCallOptions());
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'start' }))
    );
    port.disconnect();

    await expect(execution).resolves.toEqual({
      success: false,
      error: { code: 'PDF_READER_REQUIRED', message: 'The local PDF reader is unavailable.' },
    });
  });

  it('fails closed when the captured document no longer owns settlement', async () => {
    const port = fakePdfPort(pdfResult);
    vi.stubGlobal('chrome', {
      scripting: {
        executeScript: vi.fn(async (details: { func?: unknown }) => [
          {
            documentId: 'doc-1',
            frameId: 0,
            result: details.func ? 'application/pdf' : undefined,
          },
        ]),
      },
      tabs: { connect: vi.fn(() => port) },
    });
    mocks.ownsDocument.mockReturnValue(false);
    const tool = createReadPageTool(7);

    await expect(tool.execute?.({}, toolCallOptions())).resolves.toMatchObject({
      success: false,
      error: { code: 'NAVIGATED' },
    });
  });

  it('cancels and disconnects document-owned work when the caller aborts', async () => {
    const port = fakePdfPort();
    vi.stubGlobal('chrome', {
      scripting: {
        executeScript: vi.fn(async (details: { func?: unknown }) => [
          {
            documentId: 'doc-1',
            frameId: 0,
            result: details.func ? 'application/pdf' : undefined,
          },
        ]),
      },
      tabs: { connect: vi.fn(() => port) },
    });
    const controller = new AbortController();
    const tool = createReadPageTool(7);
    const execution = tool.execute?.({}, toolCallOptions(controller.signal));
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'start' }))
    );

    controller.abort(new Error('caller cancelled'));

    await expect(execution).rejects.toThrow('caller cancelled');
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'cancel' });
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('does no document work after the built-in is disabled', async () => {
    mocks.isBuiltinToolEnabled.mockResolvedValue(false);
    const executeScript = vi.fn();
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn() },
    });
    const tool = createReadPageTool(7);

    await expect(tool.execute?.({}, toolCallOptions())).rejects.toThrow('Tool disabled');
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('does no browser work for an already-aborted call', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    const executeScript = vi.fn();
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn() },
    });
    const tool = createReadPageTool(7);

    await expect(tool.execute?.({}, toolCallOptions(controller.signal))).rejects.toThrow(
      'caller cancelled'
    );
    expect(executeScript).not.toHaveBeenCalled();
  });
});
