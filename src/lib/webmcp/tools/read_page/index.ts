import { tool } from 'ai';
import { z } from 'zod';
import { ConfigStorage } from '../../../storage/config';
import { getTabManager } from '../../lifecycle';
import { withAbortReason } from './abort';
import { readHtmlDocument } from './html-runner';
import {
  READ_PAGE_DESCRIPTION,
  READ_PAGE_PARAMETER_DESCRIPTIONS,
  READ_PAGE_TOOL_NAME,
} from './metadata';
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

export { READ_PAGE_TOOL_NAME } from './metadata';

const DOCUMENT_TYPE_PROBE_TIMEOUT_MS = 10_000;
const READABLE_DOCUMENT_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'application/pdf',
]);

const readPageSchema = z
  .object({
    maxLength: z
      .number()
      .min(PDF_MIN_MAX_LENGTH)
      .max(PDF_HARD_MAX_LENGTH)
      .optional()
      .describe(READ_PAGE_PARAMETER_DESCRIPTIONS.maxLength),
    startPage: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(READ_PAGE_PARAMETER_DESCRIPTIONS.startPage),
    maxPages: z
      .number()
      .int()
      .min(1)
      .max(PDF_HARD_MAX_PAGES)
      .optional()
      .describe(READ_PAGE_PARAMETER_DESCRIPTIONS.maxPages),
  })
  .strict();

export type ReadPageInput = z.infer<typeof readPageSchema>;

function failure(code: PdfFailure['error']['code'], message: string): PdfFailure {
  return { success: false, error: { code, message } };
}

function normalizeOptions(input: ReadPageInput): PdfReadOptions {
  return {
    // HTML historically accepts fractional numbers and floors them; keep one public schema while
    // normalizing the PDF worker's integer-only control plane at this boundary.
    maxLength: Math.floor(input.maxLength ?? PDF_DEFAULT_MAX_LENGTH),
    startPage: input.startPage ?? 1,
    maxPages: input.maxPages ?? PDF_DEFAULT_MAX_PAGES,
  };
}

async function probeContentType(tabId: number, documentId: string): Promise<string> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, documentIds: [documentId] },
    world: 'ISOLATED',
    func: () => document.contentType,
  });
  const result = results.length === 1 ? results[0] : undefined;
  if (!result || result.documentId !== documentId || result.frameId !== 0) {
    throw new Error('Document route changed');
  }
  if (typeof result.result !== 'string') {
    throw new Error('Document content type is unavailable');
  }
  const contentType = result.result.trim().toLowerCase();
  if (!READABLE_DOCUMENT_CONTENT_TYPES.has(contentType)) {
    throw new Error('Document content type is unsupported');
  }
  return contentType;
}

async function detectDocumentType(
  tabId: number,
  documentId: string,
  abortSignal?: AbortSignal
): Promise<{ contentType?: string; failure?: PdfFailure }> {
  const probe = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => probe.abort(abortSignal?.reason);
  abortSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    probe.abort(new DOMException('Document type probe timed out', 'TimeoutError'));
  }, DOCUMENT_TYPE_PROBE_TIMEOUT_MS);

  try {
    return {
      contentType: await withAbortReason(probeContentType(tabId, documentId), probe.signal),
    };
  } catch {
    if (abortSignal?.aborted) throw abortSignal.reason;
    if (timedOut) {
      return { failure: failure('TIMEOUT', 'Document type detection exceeded its time limit.') };
    }
    return {
      failure: getTabManager().ownsDocument(tabId, documentId)
        ? failure('PARSE_FAILED', 'The document type could not be determined.')
        : failure('NAVIGATED', 'The document route was replaced before it could be read.'),
    };
  } finally {
    clearTimeout(timeout);
    abortSignal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * One extension-owned document reader chooses its HTML or PDF implementation from browser-owned
 * content type. The model-facing registry remains independent of page-reported tool descriptors.
 */
export function createReadPageTool(tabId: number) {
  return tool({
    description: READ_PAGE_DESCRIPTION,
    inputSchema: readPageSchema,
    execute: async (untrustedInput, { abortSignal }: { abortSignal?: AbortSignal } = {}) => {
      const parsed = readPageSchema.safeParse(untrustedInput === undefined ? {} : untrustedInput);
      if (!parsed.success) throw new Error('WebMCP tool arguments are invalid');
      if (abortSignal?.aborted) throw abortSignal.reason;

      const isEnabled = await withAbortReason(
        ConfigStorage.getInstance().isBuiltinToolEnabled(READ_PAGE_TOOL_NAME),
        abortSignal
      );
      if (!isEnabled) throw new Error('Tool disabled');

      const tabManager = getTabManager();
      const route = tabManager.getOwnedDocument(tabId);
      if (!route) throw new Error('The read-page document route is unavailable.');

      const detected = await detectDocumentType(tabId, route.documentId, abortSignal);
      if (detected.failure) return detected.failure;

      if (detected.contentType !== 'application/pdf') {
        const htmlInput =
          parsed.data.maxLength === undefined ? {} : { maxLength: parsed.data.maxLength };
        try {
          const result = await readHtmlDocument(tabId, route.documentId, htmlInput, abortSignal);
          if (!tabManager.ownsDocument(tabId, route.documentId)) {
            return failure('NAVIGATED', 'The HTML document route was replaced before settlement.');
          }
          return result;
        } catch (error) {
          if (!tabManager.ownsDocument(tabId, route.documentId)) {
            return failure('NAVIGATED', 'The HTML document route was replaced before settlement.');
          }
          if (error instanceof DOMException && error.name === 'TimeoutError') {
            return failure('TIMEOUT', 'HTML extraction exceeded its time limit.');
          }
          throw error;
        }
      }

      const result = await readPdfDocument(
        tabId,
        route.documentId,
        normalizeOptions(parsed.data),
        abortSignal
      );
      if (!tabManager.ownsDocument(tabId, route.documentId)) {
        return failure('NAVIGATED', 'The PDF document route was replaced before settlement.');
      }
      return result;
    },
  });
}
