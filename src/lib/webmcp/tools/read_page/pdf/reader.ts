import log from '../../../../logger';
import { getTabManager } from '../../../lifecycle';
import { withAbortReason } from '../abort';
import {
  PDF_DOCUMENT_HOST_FILE,
  PDF_HOST_PORT_PREFIX,
  type PdfFailure,
  type PdfHostMessage,
  type PdfReadOptions,
  type PdfReadResult,
} from './protocol';
import { issuePdfWorkerCapability, releasePdfWorkerCapability } from './capabilities';

const PDF_TIMEOUT_MS = 20_000;

function failure(code: PdfFailure['error']['code'], message: string): PdfFailure {
  return { success: false, error: { code, message } };
}

async function injectPdfHost(tabId: number, documentId: string): Promise<void> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, documentIds: [documentId] },
    world: 'ISOLATED',
    injectImmediately: true,
    files: [PDF_DOCUMENT_HOST_FILE],
  });
  const result = results.length === 1 ? results[0] : undefined;
  if (!result || result.documentId !== documentId || result.frameId !== 0) {
    throw new Error('Document route changed');
  }
}

function runPdfHost(
  tabId: number,
  documentId: string,
  options: PdfReadOptions,
  capability: string,
  abortSignal: AbortSignal
): Promise<PdfReadResult> {
  if (abortSignal.aborted) return Promise.reject(abortSignal.reason);

  return new Promise((resolve, reject) => {
    const port = chrome.tabs.connect(tabId, {
      documentId,
      name: `${PDF_HOST_PORT_PREFIX}${globalThis.crypto.randomUUID()}`,
    });
    let settled = false;
    let ready = false;

    const cleanup = () => {
      abortSignal.removeEventListener('abort', onAbort);
      try {
        port.disconnect();
      } catch {
        // The document route may already be gone.
      }
    };
    const finish = (result: PdfReadResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      try {
        port.postMessage({ type: 'cancel' });
      } catch {
        // Disconnect is sufficient to abort document-owned work.
      }
      fail(abortSignal.reason);
    };

    abortSignal.addEventListener('abort', onAbort, { once: true });
    port.onDisconnect.addListener(() => {
      if (!settled) fail(new Error('PDF document host disconnected'));
    });
    port.onMessage.addListener((message: PdfHostMessage) => {
      if (message?.type === 'ready' && !ready) {
        ready = true;
        port.postMessage({ type: 'start', capability, options });
        return;
      }
      if (message?.type === 'result') finish(message.result);
    });
  });
}

export async function readPdfDocument(
  tabId: number,
  documentId: string,
  options: PdfReadOptions,
  abortSignal?: AbortSignal
): Promise<PdfReadResult> {
  if (abortSignal?.aborted) throw abortSignal.reason;

  const operation = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => operation.abort(abortSignal?.reason);
  abortSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    operation.abort(new DOMException('PDF extraction timed out', 'TimeoutError'));
  }, PDF_TIMEOUT_MS);
  const capability = issuePdfWorkerCapability(tabId, documentId);

  try {
    if (!capability) {
      return failure('PDF_READER_REQUIRED', 'Another PDF read is already active.');
    }
    await withAbortReason(injectPdfHost(tabId, documentId), operation.signal);
    const result = await runPdfHost(tabId, documentId, options, capability, operation.signal);
    return timedOut ? failure('TIMEOUT', 'PDF extraction exceeded its time limit.') : result;
  } catch {
    if (timedOut) return failure('TIMEOUT', 'PDF extraction exceeded its time limit.');
    if (abortSignal?.aborted) throw abortSignal.reason;
    if (!getTabManager().ownsDocument(tabId, documentId)) {
      return failure('NAVIGATED', 'The PDF document route was replaced.');
    }
    log.warn('[PDF Reader] Exact-document host unavailable');
    return failure('PDF_READER_REQUIRED', 'The local PDF reader is unavailable.');
  } finally {
    clearTimeout(timeout);
    abortSignal?.removeEventListener('abort', onCallerAbort);
    if (capability) releasePdfWorkerCapability(capability);
  }
}
