import { PAGE_IMAGE_MAX_BYTES_PER_CALL, PAGE_IMAGE_MAX_PIXELS } from '../image-budget';
import {
  getDocument,
  PasswordException,
  PDFWorker,
  PermissionFlag,
  VerbosityLevel,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?worker&url';
import { acquireParserBytes } from './acquisition';
import { formatPdfPage } from './formatter';
import {
  PdfPageImageLimitError,
  releaseCanvas,
  renderPageImage,
  type PdfPageImageResources,
} from './page-image';
import {
  PDF_HARD_MAX_LENGTH,
  PDF_HARD_MAX_PAGES,
  PDF_MAX_BYTES,
  PDF_MIN_MAX_LENGTH,
  PDF_PAGE_IMAGE_MAX_SOURCE_PIXELS,
  type PdfEncodedPageImage,
  type PdfFailure,
  type PdfFailureCode,
  type PdfParserMessage,
  type PdfParserRequest,
  type PdfParserResult,
  type PdfSuccess,
} from './protocol';
import { collectTextItems } from './text-collector';

interface ActiveParser extends PdfPageImageResources {
  loadingTask?: PDFDocumentLoadingTask;
  document?: PDFDocumentProxy;
  pdfWorker?: PDFWorker;
  nativeWorker?: Worker;
  acquisitionController?: AbortController;
  disposePromise?: Promise<void>;
}

function failure(code: PdfFailureCode, message: string): PdfFailure {
  return { success: false, error: { code, message } };
}

function inlineText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const bounded = value.length > maxLength * 4 ? value.slice(0, maxLength * 4) : value;
  const normalized = bounded.replace(/\s+/gu, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function infoValue(info: unknown, key: string): string {
  if (!info || typeof info !== 'object') return '';
  return inlineText((info as Record<string, unknown>)[key], 200);
}

function metadataValue(metadata: unknown, key: string): string {
  if (!metadata || typeof metadata !== 'object' || !('get' in metadata)) return '';
  const get = (metadata as { get?: unknown }).get;
  if (typeof get !== 'function') return '';
  try {
    return inlineText(Reflect.apply(get, metadata, [key]), 200);
  } catch {
    return '';
  }
}

function validateParserRequest(value: unknown): PdfFailure | null {
  if (!value || typeof value !== 'object') {
    return failure('PARSE_FAILED', 'The PDF parser request was invalid.');
  }
  const request = value as Partial<PdfParserRequest>;
  const hasBytes = request.bytes instanceof ArrayBuffer;
  const localFileUrl = request.localFileUrl;
  const hasLocalFileUrl = typeof localFileUrl === 'string';
  if (hasBytes === hasLocalFileUrl) {
    return failure('PARSE_FAILED', 'The PDF parser request was invalid.');
  }
  if (hasBytes && request.bytes && request.bytes.byteLength > PDF_MAX_BYTES) {
    return failure('TOO_LARGE', 'This PDF exceeds the input byte limit.');
  }
  if (hasLocalFileUrl) {
    try {
      const url = new URL(localFileUrl);
      if (url.protocol !== 'file:' || url.hash) {
        return failure('PARSE_FAILED', 'The PDF parser request was invalid.');
      }
    } catch {
      return failure('PARSE_FAILED', 'The PDF parser request was invalid.');
    }
  }
  const options = request.options;
  if (
    !options ||
    !Number.isInteger(options.maxLength) ||
    options.maxLength < PDF_MIN_MAX_LENGTH ||
    options.maxLength > PDF_HARD_MAX_LENGTH ||
    !Number.isInteger(options.startPage) ||
    options.startPage < 1 ||
    !Number.isInteger(options.maxPages) ||
    options.maxPages < 1 ||
    options.maxPages > PDF_HARD_MAX_PAGES ||
    typeof options.includePageImages !== 'boolean' ||
    !request.source ||
    typeof request.source.title !== 'string' ||
    typeof request.source.url !== 'string'
  ) {
    return failure('PARSE_FAILED', 'The PDF parser request was invalid.');
  }
  return null;
}

function publicMetadata(
  request: PdfParserRequest,
  info: unknown,
  metadata: unknown,
  direction: 'ltr' | 'rtl'
): PdfSuccess['metadata'] {
  return {
    title:
      metadataValue(metadata, 'dc:title') ||
      infoValue(info, 'Title') ||
      inlineText(request.source.title, 200) ||
      'Untitled PDF',
    url: inlineText(request.source.url, 1_000),
    author: metadataValue(metadata, 'dc:creator') || infoValue(info, 'Author') || null,
    siteName: null,
    publishedTime: infoValue(info, 'CreationDate') || null,
    modifiedTime: infoValue(info, 'ModDate') || null,
    language: metadataValue(metadata, 'dc:language') || 'und',
    direction,
    extractedAt: new Date().toISOString(),
  };
}

function markdownHeader(
  metadata: PdfSuccess['metadata'],
  startPage: number,
  endPage: number,
  pageCount: number
): string {
  const lines = [
    `# PDF: ${metadata.title}`,
    metadata.author && `*By ${metadata.author}*`,
    metadata.url && `*Source: ${metadata.url}*`,
    `*Pages: ${startPage}–${endPage} of ${pageCount}*`,
  ].filter(Boolean);
  return `${lines.join('\n')}\n\n---`;
}

function dispose(active: ActiveParser): Promise<void> {
  // Cancellation and parse settlement can request teardown concurrently. Serialize passes and take
  // ownership of each resource before awaiting so every layer is destroyed at most once, including
  // resources assigned after an earlier cancellation pass began.
  active.disposePromise = (active.disposePromise ?? Promise.resolve()).then(async () => {
    const document = active.document;
    const loadingTask = active.loadingTask;
    const pdfWorker = active.pdfWorker;
    const nativeWorker = active.nativeWorker;
    const renderTask = active.renderTask;
    const canvas = active.canvas;
    const fileReader = active.fileReader;
    const acquisitionController = active.acquisitionController;
    active.document = undefined;
    active.loadingTask = undefined;
    active.pdfWorker = undefined;
    active.nativeWorker = undefined;
    active.renderTask = undefined;
    active.canvas = undefined;
    active.fileReader = undefined;
    active.acquisitionController = undefined;

    acquisitionController?.abort();
    try {
      fileReader?.abort();
    } catch {
      // The encoder may already have settled.
    }
    try {
      renderTask?.cancel();
      await renderTask?.promise;
    } catch {
      // Cancellation rejects the render promise after releasing PDF.js's canvas lock.
    }
    releaseCanvas(canvas);
    try {
      await document?.cleanup();
    } catch {
      // Cleanup is best-effort after parser failure or cancellation.
    }
    try {
      await loadingTask?.destroy();
    } catch {
      // The loading task may already have been destroyed by parser failure.
    }
    try {
      pdfWorker?.destroy();
    } catch {
      // The worker port may already have failed during startup.
    }
    try {
      nativeWorker?.terminate();
    } catch {
      // The native worker may have failed during startup.
    }
  });
  return active.disposePromise;
}

async function parsePdf(request: PdfParserRequest, active: ActiveParser): Promise<PdfParserResult> {
  let workerReady = false;
  try {
    const acquisitionController = new AbortController();
    active.acquisitionController = acquisitionController;
    let acquired: Awaited<ReturnType<typeof acquireParserBytes>>;
    try {
      acquired = await acquireParserBytes(request, acquisitionController.signal);
    } finally {
      if (active.acquisitionController === acquisitionController) {
        active.acquisitionController = undefined;
      }
    }
    if (acquired.failure) return acquired.failure;
    if (!acquired.bytes) return failure('REFETCH_FAILED', 'The PDF could not be read.');

    const nativeWorker = new Worker(pdfWorkerUrl, { type: 'module', name: 'agentboard-pdfjs' });
    const pdfWorker = PDFWorker.create({
      port: nativeWorker,
      verbosity: VerbosityLevel.ERRORS,
    });
    active.nativeWorker = nativeWorker;
    active.pdfWorker = pdfWorker;
    await pdfWorker.promise;
    workerReady = true;
    if (active.cancelled) return failure('CANCELLED', 'PDF extraction was cancelled.');

    const loadingTask = getDocument({
      data: new Uint8Array(acquired.bytes),
      worker: pdfWorker,
      verbosity: VerbosityLevel.ERRORS,
      enableXfa: false,
      // Visual calls fail rather than silently omit source images above maxImageSize; callers can
      // explicitly retry text-only extraction when a hostile or unusually large image is present.
      stopAtErrors: request.options.includePageImages,
      maxImageSize: PDF_PAGE_IMAGE_MAX_SOURCE_PIXELS,
      canvasMaxAreaInBytes: PAGE_IMAGE_MAX_PIXELS * 4,
      useSystemFonts: false,
      useWasm: false,
      useWorkerFetch: false,
    });
    active.loadingTask = loadingTask;
    const document = await loadingTask.promise;
    active.document = document;
    if (active.cancelled) return failure('CANCELLED', 'PDF extraction was cancelled.');

    const permissions = await document.getPermissions();
    if (permissions && !permissions.includes(PermissionFlag.COPY)) {
      return failure('COPY_NOT_PERMITTED', 'This PDF does not permit text copying.');
    }

    const startPage = request.options.startPage;
    if (startPage > document.numPages) {
      return failure('PARSE_FAILED', 'The requested page is outside this PDF.');
    }
    const requestedEnd = Math.min(document.numPages, startPage + request.options.maxPages - 1);
    const metadataResult = await document.getMetadata().catch(() => ({ info: {}, metadata: null }));
    const baseMetadata = publicMetadata(
      request,
      metadataResult.info,
      metadataResult.metadata,
      'ltr'
    );
    const pages: Array<{ pageNumber: number; text: string }> = [];
    const pageImages: PdfSuccess['pdf']['pageImages'] = [];
    const pageImageData: PdfEncodedPageImage[] = [];
    const warnings = new Set<string>();
    let totalItems = 0;
    let totalCharacters = 0;
    let totalImageBytes = 0;
    let textPageCount = 0;
    let rtlItems = 0;
    let ltrItems = 0;
    let layoutMode: PdfSuccess['pdf']['layoutMode'] = 'plain';
    let bodyLength = 0;
    let nextPage: number | null = null;
    let truncated = false;

    for (let pageNumber = startPage; pageNumber <= requestedEnd; pageNumber += 1) {
      if (active.cancelled) return failure('CANCELLED', 'PDF extraction was cancelled.');
      const page = await document.getPage(pageNumber);
      try {
        const collected = await collectTextItems(
          page,
          () => active.cancelled,
          totalItems,
          totalCharacters
        );
        if (!collected.success) {
          if (collected.scope === 'call' && pages.length > 0) {
            nextPage = pageNumber;
            truncated = true;
            break;
          }
          return collected.failure;
        }
        let pageRtlItems = 0;
        let pageLtrItems = 0;
        for (const { dir } of collected.items) {
          if (dir === 'rtl') pageRtlItems += 1;
          else if (dir === 'ltr') pageLtrItems += 1;
        }
        const viewport = page.getViewport({ scale: 1 });
        const formatted = formatPdfPage(collected.items, viewport.width, {
          rotation: page.rotate,
        });
        const pageMarkdown = `## Page ${pageNumber}\n\n${formatted.text || '[No extractable text]'}`;
        const header = markdownHeader(baseMetadata, startPage, pageNumber, document.numPages);
        const separatorLength = pages.length > 0 ? 2 : 0;
        const projectedLength =
          header.length + 2 + bodyLength + separatorLength + pageMarkdown.length;
        if (projectedLength > request.options.maxLength) {
          if (pages.length === 0) {
            return failure('TOO_LARGE', 'The first requested PDF page exceeds the output limit.');
          }
          nextPage = pageNumber;
          truncated = true;
          break;
        }

        let image: PdfEncodedPageImage | null = null;
        if (request.options.includePageImages) {
          try {
            image = await renderPageImage(
              page,
              pageNumber,
              pageImages.length + 1,
              PAGE_IMAGE_MAX_BYTES_PER_CALL - totalImageBytes,
              active
            );
          } catch (error) {
            if (active.cancelled) {
              return failure('CANCELLED', 'PDF extraction was cancelled.');
            }
            if (pages.length === 0) {
              return error instanceof PdfPageImageLimitError
                ? failure(
                    'TOO_LARGE',
                    'The first requested PDF page exceeds the media limit. Retry with includePageImages set to false for text-only extraction.'
                  )
                : failure(
                    'PARSE_FAILED',
                    'The first requested PDF page could not be rendered or encoded. Retry with includePageImages set to false for text-only extraction.'
                  );
            }
            warnings.add(
              `${error instanceof PdfPageImageLimitError ? 'PAGE_IMAGE_LIMIT_REACHED' : 'PAGE_IMAGE_FAILED'}:page-${pageNumber}`
            );
            nextPage = pageNumber;
            truncated = true;
            break;
          }
        }

        // Commit text, counters, and media together only after every page resource fits.
        totalItems += collected.itemCount;
        totalCharacters += collected.characterCount;
        rtlItems += pageRtlItems;
        ltrItems += pageLtrItems;
        if (formatted.mode === 'layout') layoutMode = 'layout';
        for (const warning of formatted.warnings) {
          warnings.add(`${warning}:page-${pageNumber}`);
        }
        if (formatted.text) textPageCount += 1;
        else warnings.add(`NO_PAGE_TEXT:page-${pageNumber}`);
        pages.push({ pageNumber, text: pageMarkdown });
        bodyLength += separatorLength + pageMarkdown.length;
        if (image) {
          pageImages.push({
            imageIndex: image.imageIndex,
            pageNumber: image.pageNumber,
            width: image.width,
            height: image.height,
            mediaType: image.mediaType,
            detail: image.detail,
          });
          pageImageData.push(image);
          totalImageBytes += image.byteLength;
        }
      } finally {
        page.cleanup();
      }
    }

    if (textPageCount === 0 && pageImages.length === 0) {
      return failure('NO_EXTRACTABLE_TEXT', 'No extractable text is available in this PDF range.');
    }

    const endPage = pages.at(-1)?.pageNumber ?? startPage;
    if (nextPage === null && endPage < document.numPages) nextPage = endPage + 1;
    const metadata = {
      ...baseMetadata,
      direction: rtlItems > ltrItems ? ('rtl' as const) : ('ltr' as const),
    };
    const header = markdownHeader(metadata, startPage, endPage, document.numPages);
    const markdownContent = `${header}\n\n${pages.map(({ text }) => text).join('\n\n')}`;
    const pageHeadingOffsets: number[] = [];
    let pageOffset = header.length + 2;
    for (const page of pages) {
      pageHeadingOffsets.push(pageOffset);
      pageOffset += page.text.length + 2;
    }
    if (markdownContent.length > request.options.maxLength) {
      return failure('TOO_LARGE', 'The requested PDF range exceeds the output limit.');
    }
    const words = markdownContent.split(/\s+/u).filter(Boolean).length;

    return {
      success: true,
      extractionMode: 'pdf',
      metadata,
      markdownContent,
      truncated,
      warnings: [...warnings],
      pdf: {
        pageCount: document.numPages,
        startPage,
        endPage,
        nextPage,
        layoutMode,
        pageImages,
      },
      stats: {
        characterCount: markdownContent.length,
        wordCount: words,
        estimatedReadTime: Math.ceil(words / 200),
        extractedPageCount: pages.length,
      },
      pageImageData,
      pageHeadingOffsets,
    };
  } catch (error) {
    if (active.cancelled) return failure('CANCELLED', 'PDF extraction was cancelled.');
    if (!workerReady) {
      return failure('PDF_READER_REQUIRED', 'The local PDF reader could not start.');
    }
    if (error instanceof PasswordException) {
      return failure('PASSWORD_REQUIRED', 'This PDF requires a password.');
    }
    if (error instanceof DOMException && error.name === 'DataCloneError') {
      return failure('UNSUPPORTED_ENCODING', 'This PDF uses an unsupported encoding.');
    }
    return failure('PARSE_FAILED', 'The PDF could not be parsed.');
  } finally {
    await dispose(active);
  }
}

export interface PdfParserSession {
  cancel(): void;
}

/** Attach the heavyweight parser only after the tiny worker host has claimed its capability. */
export function attachPdfParser(parserPort: MessagePort): PdfParserSession {
  let active: ActiveParser | null = null;

  const cancel = () => {
    if (active) {
      active.cancelled = true;
      void dispose(active);
    }
    parserPort.close();
  };

  parserPort.onmessage = async ({ data }: MessageEvent<PdfParserMessage>) => {
    if (data?.type === 'cancel') {
      cancel();
      return;
    }
    if (data?.type !== 'parse' || active) return;
    const validationFailure = validateParserRequest(data);
    if (validationFailure) {
      parserPort.postMessage(validationFailure);
      parserPort.close();
      return;
    }

    const parser: ActiveParser = { cancelled: false };
    active = parser;
    const result = await parsePdf(data, parser);
    if (!parser.cancelled) parserPort.postMessage(result);
    parserPort.close();
    active = null;
  };
  parserPort.start();

  return { cancel };
}
