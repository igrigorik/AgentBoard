import {
  HTML_READER_DEADLINE_MS,
  HTML_READER_HOST_FILE,
  HTML_READER_HOST_KEY,
  HTML_READER_HOST_VERSION,
  type HtmlReadResult,
} from './html-protocol';

/**
 * `chrome.scripting.executeScript` resolves when the injected function throws and reports
 * only `result: undefined` -- no error field, no rejection, and `InjectionResult` has no
 * error member to populate. Anything the injected code wants the worker to know it must
 * therefore *return*, which is why both the handshake and the extractor's own failure
 * travel as values.
 */
type HostEnvelope =
  | { host: 'missing' }
  | { host: 'version-mismatch'; found: unknown }
  | { host: 'threw'; name: string; message: string }
  | { host: 'ready'; result: unknown };

/**
 * Bounded inside the injected function so an oversized message is never serialized across
 * the boundary. A page cannot reach AgentBoard's ISOLATED world, but it does supply the
 * DOM the extractor reads, so it can influence what an error says.
 */
const MAX_HOST_ERROR_CHARS = 512;

function isHostEnvelope(value: unknown): value is HostEnvelope {
  return isRecord(value) && typeof value.host === 'string';
}

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
  const viewport = value.viewport;
  return (
    typeof value.extractionMode === 'string' &&
    // 'viewport-only' is service-worker-assembled; the private host must never emit it.
    ['article', 'rendered-text', 'metadata'].includes(value.extractionMode) &&
    isRecord(viewport) &&
    typeof viewport.scrollPercent === 'number' &&
    Number.isFinite(viewport.scrollPercent) &&
    viewport.scrollPercent >= 0 &&
    viewport.scrollPercent <= 100 &&
    typeof viewport.firstVisibleText === 'string' &&
    typeof viewport.lastVisibleText === 'string' &&
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
    func: async (
      hostKey: string,
      hostVersion: number,
      args: { maxLength?: number },
      maxErrorChars: number
    ) => {
      const host = (
        globalThis as typeof globalThis & {
          [key: string]: unknown;
        }
      )[hostKey] as
        | { version?: unknown; execute?: (value: { maxLength?: number }) => Promise<unknown> }
        | undefined;
      if (typeof host?.execute !== 'function') return { host: 'missing' };
      if (host.version !== hostVersion) return { host: 'version-mismatch', found: host.version };
      try {
        return { host: 'ready', result: await host.execute(args) };
      } catch (error) {
        // The only way an extractor failure survives the boundary. Without this catch a
        // Readability crash, a cross-origin DOM access, or any other real fault arrives as
        // an indistinguishable `undefined` and gets reported as "no result".
        const raw = error instanceof Error ? error.message : String(error);
        return {
          host: 'threw',
          name: error instanceof Error ? error.name : 'Error',
          message: raw.length > maxErrorChars ? `${raw.slice(0, maxErrorChars)}[truncated]` : raw,
        };
      }
    },
    args: [HTML_READER_HOST_KEY, HTML_READER_HOST_VERSION, input, MAX_HOST_ERROR_CHARS],
  });
  const envelope = exactTopDocumentResult(executed, documentId).result;
  enforceSettlementBoundary(abortSignal, deadline);

  // Reaching here means the injected function failed before its own catch could run, which
  // in practice means the document was torn down mid-execution.
  if (!isHostEnvelope(envelope)) {
    throw new Error(
      'The page reader did not return a result; the document was most likely replaced while it was reading.'
    );
  }
  if (envelope.host === 'threw') {
    throw new Error(
      `The page reader failed while extracting: ${envelope.name}: ${envelope.message}`
    );
  }
  if (envelope.host === 'missing') {
    throw new Error(
      'The page reader could not be installed in this document. Reading a different page may work; a restricted or unloaded document will not.'
    );
  }
  if (envelope.host === 'version-mismatch') {
    // Unreachable in a published build: the host file is reinjected before every call and
    // replaces itself on any version difference, so the page always ends up running whatever
    // is on disk, and a store update swaps disk and worker together. Skew needs the two to
    // diverge, which in practice means an unpacked build rebuilt under a worker Chrome has
    // not restarted. That is a developer's situation, and the message says so rather than
    // handing a user an instruction they cannot act on.
    throw new Error(
      `The page reader is from a different build than the extension: this document has reader version ${String(envelope.found)} and the extension expects ${HTML_READER_HOST_VERSION}. Reload the unpacked extension at chrome://extensions.`
    );
  }
  if (!isHtmlReadResult(envelope.result)) {
    throw new Error('The page reader returned a malformed result.');
  }
  return envelope.result;
}
