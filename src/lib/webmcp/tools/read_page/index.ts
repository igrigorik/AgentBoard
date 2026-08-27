import { tool } from 'ai';
import { prepareToolInputSchema } from '../../../schema/tool-input-schema';
import { ConfigStorage } from '../../../storage/config';
import { withAbortReason } from './abort';
import type { HtmlReadResult, HtmlReadSuccess } from './html-protocol';
import { readHtmlDocument } from './html-runner';
import { READ_PAGE_DESCRIPTION, READ_PAGE_METADATA, READ_PAGE_TOOL_NAME } from './metadata';
import { publishHtmlResult, publishPdfResult, readPageModelOutput } from './model-output';
import {
  PDF_DEFAULT_MAX_LENGTH,
  PDF_DEFAULT_MAX_PAGES,
  type PdfFailure,
  type PdfReadOptions,
} from './pdf/protocol';
import { readPdfDocument } from './pdf/reader';
import type { ExactDocumentRoute } from './route';
import { resolveReadRoute } from './route';
import {
  captureViewport,
  viewportUnavailable,
  type ViewportCaptureOutcome,
} from './viewport-capture';

export { READ_PAGE_TOOL_NAME } from './metadata';

export interface ReadPageInput extends Record<string, unknown> {
  maxLength?: number;
  startPage?: number;
  maxPages?: number;
  includePageImages?: boolean;
}

const preparedInput = prepareToolInputSchema(READ_PAGE_METADATA.inputSchema);

function failure(code: PdfFailure['error']['code'], message: string): PdfFailure {
  return { success: false, error: { code, message } };
}

function validateInput(value: unknown): ReadPageInput {
  const validation = preparedInput.validateInput(value === undefined ? {} : value);
  if (!validation.success) throw new Error('WebMCP tool arguments are invalid');
  return validation.value as ReadPageInput;
}

/** Assembled when extraction failed but the viewport capture succeeded on the current route. */
async function viewportOnlyResult(tabId: number, warning: string): Promise<HtmlReadSuccess> {
  let title = 'Untitled page';
  let url = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.title) title = tab.title;
    if (tab.url) url = tab.url;
  } catch {
    // Tab metadata is best-effort context; the capture is the content.
  }
  return {
    success: true,
    extractionMode: 'viewport-only',
    metadata: {
      title,
      url,
      author: null,
      siteName: null,
      publishedTime: null,
      modifiedTime: null,
      language: 'und',
      direction: 'ltr',
      extractedAt: new Date().toISOString(),
    },
    markdownContent: '',
    truncated: false,
    stats: { characterCount: 0, wordCount: 0, estimatedReadTime: 0 },
    warnings: [warning],
  };
}

/**
 * Extraction and viewport capture run concurrently against the same immutable
 * moment of the document; neither mutates page state. The capture is fail-soft:
 * its absence downgrades to a warning, never a failed read.
 */
async function readHtmlWithViewport(
  route: ExactDocumentRoute,
  input: ReadPageInput,
  abortSignal?: AbortSignal
): Promise<HtmlReadResult | PdfFailure> {
  const htmlInput = input.maxLength === undefined ? {} : { maxLength: input.maxLength };
  const includeImage = input.includePageImages ?? true;

  const [extraction, captureOutcome] = await Promise.allSettled([
    readHtmlDocument(route.tabId, route.documentId, htmlInput, abortSignal),
    includeImage ? captureViewport(route, abortSignal) : Promise.resolve(null),
  ]);
  if (abortSignal?.aborted) throw abortSignal.reason;

  const outcome: ViewportCaptureOutcome | null =
    captureOutcome.status === 'fulfilled' ? captureOutcome.value : null;
  const captureWarning = !includeImage
    ? null
    : captureOutcome.status === 'rejected'
      ? viewportUnavailable('capture-failed')
      : (outcome?.warning ?? null);

  if (!(await route.isCurrent(abortSignal))) {
    return failure('NAVIGATED', 'The HTML document route was replaced before settlement.');
  }

  if (extraction.status === 'fulfilled') {
    const result = extraction.value;
    // Host-reported failures (Chrome PDF viewer shell) route to the PDF reader; a
    // screenshot of the viewer shell is exactly what the PDF work banned.
    if (!result.success) return result;
    // The service worker owns `warnings` unconditionally: the private host is validated
    // by shape, not sanitized, so anything it attached is dropped rather than forwarded.
    if (captureWarning) result.warnings = [captureWarning];
    else delete result.warnings;
    return outcome?.capture ? publishHtmlResult(result, outcome.capture) : result;
  }

  const error = extraction.reason;
  if (outcome?.capture) {
    const warning =
      error instanceof DOMException && error.name === 'TimeoutError'
        ? 'HTML_EXTRACTION_TIMEOUT'
        : 'HTML_EXTRACTION_FAILED';
    return publishHtmlResult(await viewportOnlyResult(route.tabId, warning), outcome.capture);
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return failure('TIMEOUT', 'HTML extraction exceeded its time limit.');
  }
  throw error;
}

function normalizeOptions(input: ReadPageInput): PdfReadOptions {
  return {
    // HTML historically accepts fractional numbers and floors them; keep one public schema while
    // normalizing the PDF worker's integer-only control plane at this boundary.
    maxLength: Math.floor(input.maxLength ?? PDF_DEFAULT_MAX_LENGTH),
    startPage: input.startPage ?? 1,
    maxPages: input.maxPages ?? PDF_DEFAULT_MAX_PAGES,
    includePageImages: input.includePageImages ?? true,
  };
}

/**
 * One extension-owned document reader chooses its HTML or PDF implementation from browser-owned
 * content type. The model-facing registry remains independent of page-reported tool descriptors.
 */
export function createReadPageTool(tabId: number) {
  return tool({
    description: READ_PAGE_DESCRIPTION,
    inputSchema: preparedInput.inputSchema,
    execute: async (untrustedInput, { abortSignal }: { abortSignal?: AbortSignal } = {}) => {
      const input = validateInput(untrustedInput);
      if (abortSignal?.aborted) throw abortSignal.reason;

      const isEnabled = await withAbortReason(
        ConfigStorage.getInstance().isBuiltinToolEnabled(READ_PAGE_TOOL_NAME),
        abortSignal
      );
      if (!isEnabled) throw new Error('Tool disabled');

      const resolved = await resolveReadRoute(tabId, abortSignal);
      if (resolved.failure) return resolved.failure;
      const { route, contentType } = resolved;

      if (contentType !== 'application/pdf') {
        return readHtmlWithViewport(route, input, abortSignal);
      }

      const result = await readPdfDocument(route, normalizeOptions(input), abortSignal);
      if (!(await route.isCurrent(abortSignal))) {
        return failure('NAVIGATED', 'The PDF document route was replaced before settlement.');
      }
      return result.success ? publishPdfResult(result) : result;
    },
    toModelOutput: readPageModelOutput,
  });
}
