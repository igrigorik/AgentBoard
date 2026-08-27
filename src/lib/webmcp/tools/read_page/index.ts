import { tool } from 'ai';
import { prepareToolInputSchema } from '../../../schema/tool-input-schema';
import { ConfigStorage } from '../../../storage/config';
import { withAbortReason } from './abort';
import { readHtmlDocument } from './html-runner';
import { READ_PAGE_DESCRIPTION, READ_PAGE_METADATA, READ_PAGE_TOOL_NAME } from './metadata';
import { publishPdfResult, readPageModelOutput } from './pdf/model-output';
import {
  PDF_DEFAULT_MAX_LENGTH,
  PDF_DEFAULT_MAX_PAGES,
  type PdfFailure,
  type PdfReadOptions,
} from './pdf/protocol';
import { readPdfDocument } from './pdf/reader';
import { resolveReadRoute } from './route';

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
        const htmlInput = input.maxLength === undefined ? {} : { maxLength: input.maxLength };
        try {
          const result = await readHtmlDocument(
            route.tabId,
            route.documentId,
            htmlInput,
            abortSignal
          );
          if (!(await route.isCurrent(abortSignal))) {
            return failure('NAVIGATED', 'The HTML document route was replaced before settlement.');
          }
          return result;
        } catch (error) {
          if (!(await route.isCurrent(abortSignal))) {
            return failure('NAVIGATED', 'The HTML document route was replaced before settlement.');
          }
          if (error instanceof DOMException && error.name === 'TimeoutError') {
            return failure('TIMEOUT', 'HTML extraction exceeded its time limit.');
          }
          throw error;
        }
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
