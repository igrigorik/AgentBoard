import {
  HTML_READER_DEADLINE_MS,
  HTML_READER_HOST_FILE,
  HTML_READER_HOST_KEY,
  HTML_READER_HOST_VERSION,
  type HtmlReadResult,
} from './html-protocol';

function exactTopDocumentResult<T>(
  results: chrome.scripting.InjectionResult<T>[],
  documentId: string
): chrome.scripting.InjectionResult<T> {
  const result = results.length === 1 ? results[0] : undefined;
  if (!result || result.documentId !== documentId || result.frameId !== 0) {
    throw new Error('Document route changed');
  }
  return result;
}

function enforceSettlementBoundary(abortSignal: AbortSignal | undefined, deadline: number): void {
  if (abortSignal?.aborted) throw abortSignal.reason;
  if (Date.now() >= deadline) {
    throw new DOMException('HTML extraction timed out', 'TimeoutError');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): boolean {
  return typeof value === 'string' || value === null;
}

function isNonnegativeNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isHtmlReadResult(value: unknown): value is HtmlReadResult {
  if (!isRecord(value) || typeof value.success !== 'boolean') return false;
  if (!value.success) {
    return (
      isRecord(value.error) &&
      value.error.code === 'PDF_READER_REQUIRED' &&
      typeof value.error.message === 'string'
    );
  }

  const metadata = value.metadata;
  const stats = value.stats;
  return (
    typeof value.extractionMode === 'string' &&
    ['article', 'rendered-text', 'metadata'].includes(value.extractionMode) &&
    isRecord(metadata) &&
    typeof metadata.title === 'string' &&
    typeof metadata.url === 'string' &&
    isNullableString(metadata.author) &&
    isNullableString(metadata.siteName) &&
    isNullableString(metadata.publishedTime) &&
    isNullableString(metadata.modifiedTime) &&
    typeof metadata.language === 'string' &&
    typeof metadata.direction === 'string' &&
    typeof metadata.extractedAt === 'string' &&
    typeof value.markdownContent === 'string' &&
    typeof value.truncated === 'boolean' &&
    isRecord(stats) &&
    isNonnegativeNumber(stats.characterCount) &&
    isNonnegativeNumber(stats.wordCount) &&
    isNonnegativeNumber(stats.estimatedReadTime)
  );
}

/** Execute the private HTML reader against the captured live document in AgentBoard's ISOLATED world. */
export async function readHtmlDocument(
  tabId: number,
  documentId: string,
  input: { maxLength?: number },
  abortSignal?: AbortSignal
): Promise<HtmlReadResult> {
  const deadline = Date.now() + HTML_READER_DEADLINE_MS;
  enforceSettlementBoundary(abortSignal, deadline);

  const installed = await chrome.scripting.executeScript({
    target: { tabId, documentIds: [documentId] },
    world: 'ISOLATED',
    injectImmediately: true,
    files: [HTML_READER_HOST_FILE],
  });
  exactTopDocumentResult(installed, documentId);
  enforceSettlementBoundary(abortSignal, deadline);

  const executed = await chrome.scripting.executeScript({
    target: { tabId, documentIds: [documentId] },
    world: 'ISOLATED',
    injectImmediately: true,
    func: async (hostKey: string, hostVersion: number, args: { maxLength?: number }) => {
      const host = (
        globalThis as typeof globalThis & {
          [key: string]: unknown;
        }
      )[hostKey] as
        | { version?: unknown; execute?: (value: { maxLength?: number }) => Promise<unknown> }
        | undefined;
      if (host?.version !== hostVersion || typeof host.execute !== 'function') {
        throw new Error('HTML reader host is unavailable');
      }
      return host.execute(args);
    },
    args: [HTML_READER_HOST_KEY, HTML_READER_HOST_VERSION, input],
  });
  const result = exactTopDocumentResult(executed, documentId).result;
  enforceSettlementBoundary(abortSignal, deadline);
  if (!isHtmlReadResult(result)) throw new Error('HTML reader returned an invalid result');
  return result;
}
