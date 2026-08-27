import { getTabManager } from '../../lifecycle';
import { withAbortReason } from './abort';
import type { PdfFailure } from './pdf/protocol';

const DOCUMENT_TYPE_PROBE_TIMEOUT_MS = 10_000;
const READABLE_DOCUMENT_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'application/pdf',
]);

export interface ExactDocumentRoute {
  readonly tabId: number;
  readonly documentId: string;
  isCurrent(abortSignal?: AbortSignal): Promise<boolean>;
}

export type ResolvedReadRoute =
  | { route: ExactDocumentRoute; contentType: string; failure?: never }
  | { route?: never; contentType?: never; failure: PdfFailure };

function failure(code: PdfFailure['error']['code'], message: string): PdfFailure {
  return { success: false, error: { code, message } };
}

function relayRoute(tabId: number, documentId: string): ExactDocumentRoute {
  return {
    tabId,
    documentId,
    async isCurrent(abortSignal) {
      abortSignal?.throwIfAborted();
      return getTabManager().ownsDocument(tabId, documentId);
    },
  };
}

function topDocumentRoute(tabId: number, documentId: string): ExactDocumentRoute {
  return {
    tabId,
    documentId,
    async isCurrent(abortSignal) {
      abortSignal?.throwIfAborted();
      try {
        const frame = await withAbortReason(
          chrome.webNavigation.getFrame({ tabId, frameId: 0 }),
          abortSignal
        );
        abortSignal?.throwIfAborted();
        return frame?.documentId === documentId;
      } catch {
        if (abortSignal?.aborted) throw abortSignal.reason;
        return false;
      }
    },
  };
}

async function probeContentType(route: ExactDocumentRoute): Promise<string> {
  const results = await chrome.scripting.executeScript({
    target: { tabId: route.tabId, documentIds: [route.documentId] },
    world: 'ISOLATED',
    func: () => document.contentType,
  });
  const result = results.length === 1 ? results[0] : undefined;
  if (!result || result.documentId !== route.documentId || result.frameId !== 0) {
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
  route: ExactDocumentRoute,
  abortSignal?: AbortSignal
): Promise<string | PdfFailure> {
  const probe = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => probe.abort(abortSignal?.reason);
  abortSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    probe.abort(new DOMException('Document type probe timed out', 'TimeoutError'));
  }, DOCUMENT_TYPE_PROBE_TIMEOUT_MS);

  try {
    return await withAbortReason(probeContentType(route), probe.signal);
  } catch {
    if (abortSignal?.aborted) throw abortSignal.reason;
    if (timedOut) {
      return failure('TIMEOUT', 'Document type detection exceeded its time limit.');
    }
    return (await route.isCurrent())
      ? failure('PARSE_FAILED', 'The document type could not be determined.')
      : failure('NAVIGATED', 'The document route was replaced before it could be read.');
  } finally {
    clearTimeout(timeout);
    abortSignal?.removeEventListener('abort', onCallerAbort);
  }
}

async function resolveLocalPdfRoute(
  tabId: number,
  abortSignal?: AbortSignal
): Promise<ResolvedReadRoute> {
  let tabUrl: URL;
  try {
    const tab = await withAbortReason(chrome.tabs.get(tabId), abortSignal);
    tabUrl = new URL(tab.url ?? '');
  } catch {
    if (abortSignal?.aborted) throw abortSignal.reason;
    return { failure: failure('ROUTE_UNAVAILABLE', 'The document route is unavailable.') };
  }
  // Not a PDF-reader problem: tabs without a relay-owned document that are not local files
  // (chrome:// pages, injection races) must not steer the model toward a PDF remedy.
  if (tabUrl.protocol !== 'file:') {
    return { failure: failure('ROUTE_UNAVAILABLE', 'The document route is unavailable.') };
  }

  try {
    if (!(await withAbortReason(chrome.extension.isAllowedFileSchemeAccess(), abortSignal))) {
      return {
        failure: failure(
          'PDF_READER_REQUIRED',
          'Enable “Allow access to file URLs” for AgentBoard, then reload this local PDF.'
        ),
      };
    }
  } catch {
    if (abortSignal?.aborted) throw abortSignal.reason;
    return { failure: failure('PDF_READER_REQUIRED', 'The local PDF reader is unavailable.') };
  }

  try {
    const results = await withAbortReason(
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'ISOLATED',
        injectImmediately: true,
        func: () => ({
          isLocal: globalThis.location.protocol === 'file:',
          contentType: document.contentType,
        }),
      }),
      abortSignal
    );
    const result = results.length === 1 ? results[0] : undefined;
    if (
      !result?.documentId ||
      result.frameId !== 0 ||
      result.result?.isLocal !== true ||
      result.result.contentType?.toLowerCase() !== 'application/pdf'
    ) {
      return { failure: failure('PARSE_FAILED', 'The local document is not a PDF.') };
    }
    return {
      route: topDocumentRoute(tabId, result.documentId),
      contentType: 'application/pdf',
    };
  } catch {
    if (abortSignal?.aborted) throw abortSignal.reason;
    return { failure: failure('PDF_READER_REQUIRED', 'The local PDF reader is unavailable.') };
  }
}

/** Resolve one exact current top-document authority before any extraction work starts. */
export async function resolveReadRoute(
  tabId: number,
  abortSignal?: AbortSignal
): Promise<ResolvedReadRoute> {
  const ownedDocument = getTabManager().getOwnedDocument(tabId);
  if (!ownedDocument) return resolveLocalPdfRoute(tabId, abortSignal);

  const route = relayRoute(tabId, ownedDocument.documentId);
  const contentType = await detectDocumentType(route, abortSignal);
  return typeof contentType === 'string' ? { route, contentType } : { failure: contentType };
}
