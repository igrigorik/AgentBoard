import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfParserMessage } from '../src/lib/webmcp/tools/read_page/pdf/protocol';

const mocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  createPdfWorker: vi.fn(),
  collectTextItems: vi.fn(),
  formatPdfPage: vi.fn(),
}));

vi.mock('pdfjs-dist', () => ({
  getDocument: mocks.getDocument,
  PasswordException: class PasswordException extends Error {},
  PDFWorker: { create: mocks.createPdfWorker },
  PermissionFlag: { COPY: 1 },
  VerbosityLevel: { ERRORS: 0 },
}));

vi.mock('pdfjs-dist/build/pdf.worker.mjs?worker&url', () => ({
  default: 'chrome-extension://test/pdf.worker.js',
}));

vi.mock('../src/lib/webmcp/tools/read_page/pdf/formatter', () => ({
  formatPdfPage: mocks.formatPdfPage,
}));

vi.mock('../src/lib/webmcp/tools/read_page/pdf/text-collector', () => ({
  collectTextItems: mocks.collectTextItems,
}));

import { attachPdfParser } from '../src/lib/webmcp/tools/read_page/pdf/worker-parser';

describe('PDF worker parser ownership', () => {
  const nativeTerminate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'Worker',
      class {
        terminate = nativeTerminate;
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('destroys every parser layer when cancellation arrives after document loading', async () => {
    let releaseCollection!: (value: unknown) => void;
    const collection = new Promise((resolve) => {
      releaseCollection = resolve;
    });
    const pdfWorker = {
      promise: Promise.resolve(),
      destroy: vi.fn(),
    };
    const page = {
      rotate: 0,
      cleanup: vi.fn(),
      getViewport: vi.fn(() => ({ width: 100 })),
    };
    const document = {
      numPages: 1,
      cleanup: vi.fn().mockResolvedValue(undefined),
      getPermissions: vi.fn().mockResolvedValue([1]),
      getMetadata: vi.fn().mockResolvedValue({ info: {}, metadata: null }),
      getPage: vi.fn().mockResolvedValue(page),
    };
    const loadingTask = {
      promise: Promise.resolve(document),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    mocks.createPdfWorker.mockReturnValue(pdfWorker);
    mocks.getDocument.mockReturnValue(loadingTask);
    mocks.collectTextItems.mockReturnValue(collection);
    mocks.formatPdfPage.mockReturnValue({ text: 'unused', mode: 'plain', warnings: [] });

    const parserPort = {
      onmessage: null as ((event: MessageEvent<PdfParserMessage>) => Promise<void>) | null,
      start: vi.fn(),
      postMessage: vi.fn(),
      close: vi.fn(),
    };
    attachPdfParser(parserPort as unknown as MessagePort);
    const request: PdfParserMessage = {
      type: 'parse',
      bytes: new ArrayBuffer(16),
      options: { maxLength: 32_000, startPage: 1, maxPages: 5 },
      source: { title: 'Fixture', url: 'https://example.test/document.pdf' },
    };

    const parsing = parserPort.onmessage!({ data: request } as MessageEvent<PdfParserMessage>);
    await vi.waitFor(() => expect(mocks.collectTextItems).toHaveBeenCalledOnce());
    await parserPort.onmessage!({ data: { type: 'cancel' } } as MessageEvent<PdfParserMessage>);

    await vi.waitFor(() => {
      expect(document.cleanup).toHaveBeenCalled();
      expect(loadingTask.destroy).toHaveBeenCalled();
      expect(pdfWorker.destroy).toHaveBeenCalled();
      expect(nativeTerminate).toHaveBeenCalled();
    });
    expect(parserPort.close).toHaveBeenCalled();
    expect(parserPort.postMessage).not.toHaveBeenCalled();

    releaseCollection({
      success: false,
      scope: 'page',
      failure: {
        success: false,
        error: { code: 'CANCELLED', message: 'PDF extraction was cancelled.' },
      },
    });
    await parsing;
    expect(document.cleanup).toHaveBeenCalledOnce();
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
    expect(pdfWorker.destroy).toHaveBeenCalledOnce();
    expect(nativeTerminate).toHaveBeenCalledOnce();
  });
});
