import { jsonSchema, tool } from 'ai';
import type { JSONSchema7 } from 'json-schema';
import { isPlainRecord } from '../../../schema/tool-input-schema';
import { ConfigStorage } from '../../../storage/config';
import { withAbortReason } from './abort';
import type { HtmlReadResult, HtmlReadSuccess } from './html-protocol';
import { readHtmlDocument } from './html-runner';
import { READ_PAGE_DESCRIPTION, READ_PAGE_METADATA, READ_PAGE_TOOL_NAME } from './metadata';
import { publishHtmlResult, publishPdfResult, readPageModelOutput } from './model-output';
import {
  PDF_DEFAULT_MAX_LENGTH,
  PDF_DEFAULT_MAX_PAGES,
  PDF_HARD_MAX_LENGTH,
  PDF_HARD_MAX_PAGES,
  PDF_MIN_MAX_LENGTH,
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

function failure(code: PdfFailure['error']['code'], message: string): PdfFailure {
  return { success: false, error: { code, message } };
}

const INVALID_INPUT = 'WebMCP tool arguments are invalid';

/**
 * The tool owns its argument contract: this checks the four optional fields against the same
 * bounds READ_PAGE_METADATA advertises, so the model's repair step names the field it got wrong.
 */
function checkInput(
  value: unknown
): { success: true; value: ReadPageInput } | { success: false; error: Error } {
  const fail = (detail: string) => ({
    success: false as const,
    error: new Error(`${INVALID_INPUT}: ${detail}`),
  });
  if (!isPlainRecord(value)) return fail('arguments must be an object');

  const unknownKeys = Object.keys(value).filter(
    (key) => !Object.hasOwn(READ_PAGE_METADATA.inputSchema.properties, key)
  );
  if (unknownKeys.length > 0) return fail(`unknown properties ${unknownKeys.join(', ')}`);

  const { maxLength, startPage, maxPages, includePageImages } = value;
  const withinNumber = (n: unknown, min: number, max: number) =>
    typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
  const withinInteger = (n: unknown, min: number, max: number) =>
    Number.isInteger(n) && (n as number) >= min && (n as number) <= max;

  if (
    maxLength !== undefined &&
    !withinNumber(maxLength, PDF_MIN_MAX_LENGTH, PDF_HARD_MAX_LENGTH)
  ) {
    return fail(
      `maxLength must be a number between ${PDF_MIN_MAX_LENGTH} and ${PDF_HARD_MAX_LENGTH}`
    );
  }
  if (startPage !== undefined && !withinInteger(startPage, 1, Number.MAX_SAFE_INTEGER)) {
    return fail('startPage must be an integer of at least 1');
  }
  if (maxPages !== undefined && !withinInteger(maxPages, 1, PDF_HARD_MAX_PAGES)) {
    return fail(`maxPages must be an integer between 1 and ${PDF_HARD_MAX_PAGES}`);
  }
  if (includePageImages !== undefined && typeof includePageImages !== 'boolean') {
    return fail('includePageImages must be a boolean');
  }
  return { success: true, value: value as ReadPageInput };
}

function validateInput(value: unknown): ReadPageInput {
  const checked = checkInput(value === undefined ? {} : value);
  if (!checked.success) throw checked.error;
  return checked.value;
}

const readPageInputSchema = jsonSchema<ReadPageInput>(
  READ_PAGE_METADATA.inputSchema as unknown as JSONSchema7,
  { validate: checkInput }
);

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
    // A viewport-only result is a success as far as the model is concerned, so the reason
    // extraction failed has nowhere else to go. Emitting the bare code discarded it and left
    // a degraded read indistinguishable from a page that is genuinely image-only. The
    // `CODE: detail` shape already exists here for page-image warnings.
    //
    // TIMEOUT keeps its bare code because the code already is the whole explanation.
    const warning =
      error instanceof DOMException && error.name === 'TimeoutError'
        ? 'HTML_EXTRACTION_TIMEOUT'
        : `HTML_EXTRACTION_FAILED: ${error instanceof Error ? error.message : 'unknown reason'}`;
    return publishHtmlResult(await viewportOnlyResult(route.tabId, warning), outcome.capture);
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return failure('TIMEOUT', 'HTML extraction exceeded its time limit.');
  }
  // Every other read_page branch returns a typed failure; rethrowing here was the one hole
  // that reached the model as an untyped exception with no code to reason about.
  return failure(
    'HTML_EXTRACTION_FAILED',
    error instanceof Error ? error.message : 'HTML extraction failed for an unknown reason.'
  );
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
    inputSchema: readPageInputSchema,
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
