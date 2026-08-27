import type { PdfParserSession } from './worker-parser';

const expectedToken = globalThis.location.hash.slice(1);
let initialized = false;
let disposed = false;
let parserPort: MessagePort | null = null;
let parserSession: PdfParserSession | null = null;

function close(): void {
  disposed = true;
  parserSession?.cancel();
  parserSession = null;
  parserPort?.close();
  parserPort = null;
}

globalThis.addEventListener('pagehide', close, { once: true });
globalThis.addEventListener('message', async (event: MessageEvent) => {
  if (
    initialized ||
    !expectedToken ||
    event.source !== globalThis.parent ||
    event.data?.token !== expectedToken ||
    event.ports.length !== 1
  ) {
    return;
  }

  initialized = true;
  parserPort = event.ports[0];
  let claim: { success?: unknown } | undefined;
  try {
    claim = await chrome.runtime.sendMessage({
      type: 'PDF_WORKER_HOST_CLAIM',
      capability: expectedToken,
    });
  } catch {
    // MV3 restart or route loss revokes the one-time capability.
  }
  if (claim?.success !== true || disposed) {
    close();
    return;
  }

  globalThis.history.replaceState(null, '', globalThis.location.pathname);
  try {
    // Keep the web-accessible host cheap for arbitrary embedders. PDF.js and its worker URL enter
    // this extension frame only after the service worker consumes a valid one-time capability.
    const { attachPdfParser } = await import('./worker-parser');
    if (disposed || !parserPort) {
      close();
      return;
    }
    parserSession = attachPdfParser(parserPort);
    parserPort.postMessage({ type: 'ready' });
  } catch {
    close();
  }
});
