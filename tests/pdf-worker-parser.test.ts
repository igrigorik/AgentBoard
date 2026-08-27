import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PDF_PAGE_IMAGE_MAX_BYTES_PER_CALL,
  PDF_PAGE_IMAGE_MAX_PIXELS,
  PDF_PAGE_IMAGE_MAX_SOURCE_PIXELS,
  type PdfParserMessage,
  type PdfParserResult,
  type PdfReadOptions,
} from '../src/lib/webmcp/tools/read_page/pdf/protocol';

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

interface FakeRenderTask {
  promise: Promise<void>;
  cancel: ReturnType<typeof vi.fn>;
}

interface FakePage {
  rotate: number;
  cleanup: ReturnType<typeof vi.fn>;
  getViewport: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
}

interface FakeParserPort {
  onmessage: ((event: MessageEvent<PdfParserMessage>) => Promise<void>) | null;
  start: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const nativeTerminate = vi.fn();
const fileReaderReads = vi.fn();

function parserPort(): FakeParserPort {
  return {
    onmessage: null,
    start: vi.fn(),
    postMessage: vi.fn(),
    close: vi.fn(),
  };
}

function attachedParserPort(): FakeParserPort {
  const port = parserPort();
  attachPdfParser(port as unknown as MessagePort);
  return port;
}

function request(options: Partial<PdfReadOptions> = {}): PdfParserMessage {
  return {
    type: 'parse',
    bytes: new ArrayBuffer(16),
    options: {
      maxLength: 32_000,
      startPage: 1,
      maxPages: 5,
      includePageImages: true,
      ...options,
    },
    source: { title: 'Fixture', url: 'https://example.test/document.pdf' },
  };
}

function localRequest(options: Partial<PdfReadOptions> = {}): PdfParserMessage {
  return {
    type: 'parse',
    localFileUrl: 'file:///private/local-document.pdf',
    options: {
      maxLength: 32_000,
      startPage: 1,
      maxPages: 5,
      includePageImages: false,
      ...options,
    },
    source: { title: 'Local PDF', url: '' },
  };
}

function page(width = 612, height = 792, renderTask?: FakeRenderTask): FakePage {
  const task = renderTask ?? { promise: Promise.resolve(), cancel: vi.fn() };
  return {
    rotate: 0,
    cleanup: vi.fn(),
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: width * scale,
      height: height * scale,
    })),
    render: vi.fn(() => task),
  };
}

function installDocument(pages: FakePage[]) {
  const pdfWorker = {
    promise: Promise.resolve(),
    destroy: vi.fn(),
  };
  const pdfDocument = {
    numPages: pages.length,
    cleanup: vi.fn().mockResolvedValue(undefined),
    getPermissions: vi.fn().mockResolvedValue([1]),
    getMetadata: vi.fn().mockResolvedValue({ info: {}, metadata: null }),
    getPage: vi.fn(async (pageNumber: number) => pages[pageNumber - 1]),
  };
  const loadingTask = {
    promise: Promise.resolve(pdfDocument),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
  mocks.createPdfWorker.mockReturnValue(pdfWorker);
  mocks.getDocument.mockReturnValue(loadingTask);
  return { pdfWorker, pdfDocument, loadingTask };
}

async function parse(
  pages: FakePage[],
  options: Partial<PdfReadOptions> = {}
): Promise<{ port: FakeParserPort; result: PdfParserResult }> {
  installDocument(pages);
  const port = attachedParserPort();
  await port.onmessage!({ data: request(options) } as MessageEvent<PdfParserMessage>);
  expect(port.postMessage).toHaveBeenCalledOnce();
  return { port, result: port.postMessage.mock.calls[0][0] as PdfParserResult };
}

function encodeJpegs(...byteLengths: number[]): void {
  let index = 0;
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    const size = byteLengths[Math.min(index, byteLengths.length - 1)];
    index += 1;
    callback({ type: 'image/jpeg', size } as Blob);
  });
}

class ImmediateFileReader {
  result: string | ArrayBuffer | null = null;
  error: DOMException | null = null;
  onabort: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
  onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
  onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;

  readAsDataURL(): void {
    fileReaderReads();
    this.result = 'data:image/jpeg;base64,ENCODED_PAGE_IMAGE';
    queueMicrotask(() => this.onload?.call(this as unknown as FileReader, {} as never));
  }

  abort(): void {
    this.onabort?.call(this as unknown as FileReader, {} as never);
  }
}

describe('PDF worker parser ownership and page images', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'Worker',
      class {
        terminate = nativeTerminate;
      }
    );
    vi.stubGlobal('FileReader', ImmediateFileReader);
    mocks.collectTextItems.mockResolvedValue({
      success: true,
      items: [],
      itemCount: 0,
      characterCount: 0,
    });
    mocks.formatPdfPage.mockReturnValue({ text: 'Page text', mode: 'plain', warnings: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('acquires an exact local PDF without placing its path in the parser result', async () => {
    const pdfBytes = new TextEncoder().encode('%PDF-1.4\nlocal fixture');
    const response = new Response(pdfBytes, {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-length': String(pdfBytes.byteLength) },
    });
    Object.defineProperty(response, 'url', { value: 'file:///private/local-document.pdf' });
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetch);
    const pdfPage = page();
    installDocument([pdfPage]);
    const port = attachedParserPort();

    await port.onmessage!({ data: localRequest() } as MessageEvent<PdfParserMessage>);

    expect(fetch).toHaveBeenCalledWith('file:///private/local-document.pdf', {
      credentials: 'omit',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(mocks.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.any(Uint8Array) })
    );
    expect(port.postMessage.mock.calls[0][0]).toMatchObject({
      success: true,
      metadata: { title: 'Local PDF', url: '' },
    });
    expect(JSON.stringify(port.postMessage.mock.calls[0][0])).not.toContain('/private/');
    expect(pdfPage.render).not.toHaveBeenCalled();
  });

  it('aborts local acquisition without starting PDF.js', async () => {
    let observedSignal: AbortSignal | undefined;
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          observedSignal = init.signal as AbortSignal;
          observedSignal.addEventListener(
            'abort',
            () => reject(new DOMException('cancelled', 'AbortError')),
            { once: true }
          );
        })
    );
    vi.stubGlobal('fetch', fetch);
    const port = attachedParserPort();

    const parsing = port.onmessage!({ data: localRequest() } as MessageEvent<PdfParserMessage>);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await port.onmessage!({ data: { type: 'cancel' } } as MessageEvent<PdfParserMessage>);
    await parsing;

    expect(observedSignal?.aborted).toBe(true);
    expect(mocks.createPdfWorker).not.toHaveBeenCalled();
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(port.close).toHaveBeenCalled();
  });

  it('rejects a non-PDF local file before starting PDF.js', async () => {
    const bytes = new TextEncoder().encode('not a PDF');
    const response = new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    });
    Object.defineProperty(response, 'url', { value: 'file:///private/local-document.pdf' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const port = attachedParserPort();

    await port.onmessage!({ data: localRequest() } as MessageEvent<PdfParserMessage>);

    expect(port.postMessage).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'REFETCH_FAILED',
        message: 'The local file did not contain PDF bytes.',
      },
    });
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });

  it('renders one bounded JPEG per admitted page and releases its working canvas', async () => {
    encodeJpegs(123);
    const pdfPage = page();

    const { result } = await parse([pdfPage]);

    expect(result).toMatchObject({
      success: true,
      pdf: {
        pageImages: [
          {
            imageIndex: 1,
            pageNumber: 1,
            width: 791,
            height: 1_024,
            mediaType: 'image/jpeg',
            detail: 'low',
          },
        ],
      },
      pageImageData: [
        {
          imageIndex: 1,
          pageNumber: 1,
          data: 'ENCODED_PAGE_IMAGE',
          byteLength: 123,
        },
      ],
    });
    expect(mocks.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        stopAtErrors: true,
        maxImageSize: PDF_PAGE_IMAGE_MAX_SOURCE_PIXELS,
        canvasMaxAreaInBytes: PDF_PAGE_IMAGE_MAX_PIXELS * 4,
      })
    );
    expect(pdfPage.render).toHaveBeenCalledWith(
      expect.objectContaining({
        canvas: expect.any(HTMLCanvasElement),
        intent: 'display',
        background: '#fff',
      })
    );
    const canvas = pdfPage.render.mock.calls[0][0].canvas as HTMLCanvasElement;
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(pdfPage.cleanup).toHaveBeenCalledOnce();
  });

  it('caps square pages at one megapixel', async () => {
    encodeJpegs(123);

    const { result } = await parse([page(2_000, 2_000)]);

    expect(result).toMatchObject({
      success: true,
      pdf: { pageImages: [{ width: 1_000, height: 1_000 }] },
    });
  });

  it('resets image indices while preserving physical page numbers across continuations', async () => {
    encodeJpegs(100, 100);

    const { result } = await parse([page(), page(), page()], {
      startPage: 2,
      maxPages: 2,
    });

    expect(result).toMatchObject({
      success: true,
      pdf: {
        startPage: 2,
        endPage: 3,
        pageImages: [
          { imageIndex: 1, pageNumber: 2 },
          { imageIndex: 2, pageNumber: 3 },
        ],
      },
      pageImageData: [
        { imageIndex: 1, pageNumber: 2 },
        { imageIndex: 2, pageNumber: 3 },
      ],
    });
  });

  it('allows visual-only pages when images are included', async () => {
    encodeJpegs(123);
    mocks.formatPdfPage.mockReturnValue({ text: '', mode: 'plain', warnings: [] });

    const { result } = await parse([page()]);

    expect(result).toMatchObject({
      success: true,
      warnings: ['NO_PAGE_TEXT:page-1'],
      pdf: { pageImages: [{ pageNumber: 1 }] },
    });
    if (result.success) expect(result.markdownContent).toContain('[No extractable text]');
  });

  it('retains the text-only failure when page images are opted out', async () => {
    mocks.formatPdfPage.mockReturnValue({ text: '', mode: 'plain', warnings: [] });
    const pdfPage = page();

    const { result } = await parse([pdfPage], { includePageImages: false });

    expect(result).toEqual({
      success: false,
      error: {
        code: 'NO_EXTRACTABLE_TEXT',
        message: 'No extractable text is available in this PDF range.',
      },
    });
    expect(pdfPage.render).not.toHaveBeenCalled();
    expect(mocks.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({ stopAtErrors: false })
    );
  });

  it('admits text and images atomically under the aggregate media budget', async () => {
    encodeJpegs(PDF_PAGE_IMAGE_MAX_BYTES_PER_CALL - 10, PDF_PAGE_IMAGE_MAX_BYTES_PER_CALL - 10);

    const { result } = await parse([page(), page()], { maxPages: 2 });

    expect(result).toMatchObject({
      success: true,
      truncated: true,
      warnings: ['PAGE_IMAGE_LIMIT_REACHED:page-2'],
      pdf: {
        endPage: 1,
        nextPage: 2,
        pageImages: [{ imageIndex: 1, pageNumber: 1 }],
      },
      stats: { extractedPageCount: 1 },
      pageImageData: [{ imageIndex: 1, pageNumber: 1 }],
    });
    if (result.success) {
      expect(result.markdownContent).toContain('## Page 1');
      expect(result.markdownContent).not.toContain('## Page 2');
    }
    expect(fileReaderReads).toHaveBeenCalledOnce();
  });

  it('does not misclassify a renderer RangeError as the media byte limit', async () => {
    encodeJpegs(123);
    const failedPage = page();
    failedPage.render.mockImplementation(() => ({
      promise: Promise.reject(new RangeError('renderer allocation failed')),
      cancel: vi.fn(),
    }));

    const { result } = await parse([page(), failedPage], { maxPages: 2 });

    expect(result).toMatchObject({
      success: true,
      truncated: true,
      warnings: ['PAGE_IMAGE_FAILED:page-2'],
      pdf: {
        endPage: 1,
        nextPage: 2,
        pageImages: [{ imageIndex: 1, pageNumber: 1 }],
      },
      pageImageData: [{ imageIndex: 1, pageNumber: 1 }],
    });
    if (result.success) expect(result.markdownContent).not.toContain('## Page 2');
  });

  it('fails closed when the first page cannot be encoded as JPEG', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
      callback(null)
    );

    const { result } = await parse([page()]);

    expect(result).toEqual({
      success: false,
      error: {
        code: 'PARSE_FAILED',
        message:
          'The first requested PDF page could not be rendered or encoded. Retry with includePageImages set to false for text-only extraction.',
      },
    });
  });

  it('skips rendering when the first page cannot fit the text output bound', async () => {
    encodeJpegs(123);
    mocks.formatPdfPage.mockReturnValue({
      text: 'x'.repeat(2_000),
      mode: 'plain',
      warnings: [],
    });
    const pdfPage = page();

    const { result } = await parse([pdfPage], { maxLength: 1_000 });

    expect(result).toMatchObject({ success: false, error: { code: 'TOO_LARGE' } });
    expect(pdfPage.render).not.toHaveBeenCalled();
  });

  it('ignores a late JPEG callback after cancellation closes the parser', async () => {
    let signalEncoding!: (callback: BlobCallback) => void;
    const encodingStarted = new Promise<BlobCallback>((resolve) => {
      signalEncoding = resolve;
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(signalEncoding);
    let signalDisposed!: () => void;
    const disposed = new Promise<void>((resolve) => {
      signalDisposed = resolve;
    });
    nativeTerminate.mockImplementationOnce(signalDisposed);
    const pdfPage = page();
    installDocument([pdfPage]);
    const port = attachedParserPort();

    const parsing = port.onmessage!({ data: request() } as MessageEvent<PdfParserMessage>);
    const encode = await encodingStarted;
    const canvas = pdfPage.render.mock.calls[0][0].canvas as HTMLCanvasElement;
    await port.onmessage!({ data: { type: 'cancel' } } as MessageEvent<PdfParserMessage>);
    await disposed;
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);

    encode({ type: 'image/jpeg', size: 123 } as Blob);
    await parsing;
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it('destroys every parser layer when cancellation arrives during rendering', async () => {
    let rejectRender!: (error: unknown) => void;
    const renderPromise = new Promise<void>((_resolve, reject) => {
      rejectRender = reject;
    });
    const renderTask = {
      promise: renderPromise,
      cancel: vi.fn(() => rejectRender(new DOMException('cancelled', 'AbortError'))),
    };
    let signalRenderStarted!: () => void;
    const renderStarted = new Promise<void>((resolve) => {
      signalRenderStarted = resolve;
    });
    const pdfPage = page(612, 792, renderTask);
    pdfPage.render.mockImplementationOnce(() => {
      signalRenderStarted();
      return renderTask;
    });
    let signalDisposed!: () => void;
    const disposed = new Promise<void>((resolve) => {
      signalDisposed = resolve;
    });
    nativeTerminate.mockImplementationOnce(signalDisposed);
    const { pdfWorker, pdfDocument, loadingTask } = installDocument([pdfPage]);
    const port = attachedParserPort();

    const parsing = port.onmessage!({ data: request() } as MessageEvent<PdfParserMessage>);
    await renderStarted;
    await port.onmessage!({ data: { type: 'cancel' } } as MessageEvent<PdfParserMessage>);
    await disposed;
    await parsing;

    expect(port.postMessage).not.toHaveBeenCalled();
    expect(renderTask.cancel).toHaveBeenCalledOnce();
    expect(pdfPage.cleanup).toHaveBeenCalledOnce();
    expect(pdfDocument.cleanup).toHaveBeenCalledOnce();
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
    expect(pdfWorker.destroy).toHaveBeenCalledOnce();
    expect(nativeTerminate).toHaveBeenCalledOnce();
  });

  it('destroys every parser layer when cancellation arrives during text collection', async () => {
    let releaseCollection!: (value: unknown) => void;
    const collection = new Promise((resolve) => {
      releaseCollection = resolve;
    });
    let signalCollectionStarted!: () => void;
    const collectionStarted = new Promise<void>((resolve) => {
      signalCollectionStarted = resolve;
    });
    mocks.collectTextItems.mockImplementation(() => {
      signalCollectionStarted();
      return collection;
    });
    let signalDisposed!: () => void;
    const disposed = new Promise<void>((resolve) => {
      signalDisposed = resolve;
    });
    nativeTerminate.mockImplementationOnce(signalDisposed);
    const pdfPage = page();
    const { pdfWorker, pdfDocument, loadingTask } = installDocument([pdfPage]);
    const port = attachedParserPort();

    const parsing = port.onmessage!({
      data: request({ includePageImages: false }),
    } as MessageEvent<PdfParserMessage>);
    await collectionStarted;
    await port.onmessage!({ data: { type: 'cancel' } } as MessageEvent<PdfParserMessage>);
    await disposed;
    expect(port.close).toHaveBeenCalled();
    expect(port.postMessage).not.toHaveBeenCalled();

    releaseCollection({
      success: false,
      scope: 'page',
      failure: {
        success: false,
        error: { code: 'CANCELLED', message: 'PDF extraction was cancelled.' },
      },
    });
    await parsing;
    expect(pdfDocument.cleanup).toHaveBeenCalledOnce();
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
    expect(pdfWorker.destroy).toHaveBeenCalledOnce();
    expect(nativeTerminate).toHaveBeenCalledOnce();
  });
});
