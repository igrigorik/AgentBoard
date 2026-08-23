import { parseHttpContentType } from './content-type';
import type {
  PdfFailure,
  PdfFailureCode,
  PdfHostControlMessage,
  PdfHostMessage,
  PdfParserMessage,
  PdfReadOptions,
  PdfReadResult,
} from './protocol';

// chrome.scripting.executeScript({ files }) loads classic scripts, so this entry must remain a
// self-contained bundle without a shared runtime import. The IIFE also prevents release-minified
// top-level bindings from colliding with the existing relay in the same ISOLATED world.
(function initializePdfDocumentHost() {
  const PDF_HOST_PORT_PREFIX = 'agentboard-pdf-reader:';
  const PDF_MAX_BYTES = 32 * 1024 * 1024;
  const WORKER_HOST_PATH = 'src/lib/webmcp/tools/read_page/pdf/worker-host.html';
  const HOST_STATE_KEY = '__agentboardPdfDocumentHostV1';

  interface HostState {
    activePorts: Set<chrome.runtime.Port>;
  }

  interface AcquiredPdf {
    bytes: ArrayBuffer;
    source: {
      title: string;
      url: string;
    };
  }

  function failure(code: PdfFailureCode, message: string): PdfFailure {
    return { success: false, error: { code, message } };
  }

  function hasPdfHeader(bytes: Uint8Array): boolean {
    const limit = Math.min(bytes.length, 1_024);
    for (let index = 0; index <= limit - 5; index += 1) {
      if (
        bytes[index] === 0x25 &&
        bytes[index + 1] === 0x50 &&
        bytes[index + 2] === 0x44 &&
        bytes[index + 3] === 0x46 &&
        bytes[index + 4] === 0x2d
      ) {
        return true;
      }
    }
    return false;
  }

  async function readBoundedBody(response: Response, signal: AbortSignal): Promise<ArrayBuffer> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > PDF_MAX_BYTES) {
      throw failure('TOO_LARGE', 'This PDF exceeds the input byte limit.');
    }
    if (!response.body) {
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > PDF_MAX_BYTES) {
        throw failure('TOO_LARGE', 'This PDF exceeds the input byte limit.');
      }
      return bytes;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > PDF_MAX_BYTES) {
          await reader.cancel();
          throw failure('TOO_LARGE', 'This PDF exceeds the input byte limit.');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  }

  async function rejectResponse(response: Response, error: PdfFailure): Promise<never> {
    try {
      await response.body?.cancel();
    } catch {
      // The response may already be closed by the network stack.
    }
    throw error;
  }

  async function acquirePdf(signal: AbortSignal): Promise<AcquiredPdf> {
    if (document.contentType.toLowerCase() !== 'application/pdf') {
      throw failure('NAVIGATED', 'The current document is no longer the requested PDF.');
    }

    const currentUrl = globalThis.location.href;
    const source = {
      title: document.title.slice(0, 800),
      url: currentUrl.slice(0, 4_000),
    };
    const requestUrl = new URL(currentUrl);
    requestUrl.hash = '';
    let response: Response;
    try {
      response = await globalThis.fetch(requestUrl.href, {
        credentials: 'include',
        redirect: 'error',
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw failure('CANCELLED', 'PDF extraction was cancelled.');
      throw error;
    }

    if (response.status === 401 || response.status === 403) {
      return rejectResponse(
        response,
        failure('AUTH_REQUIRED', 'The current PDF could not be reacquired with this page session.')
      );
    }
    if (!response.ok) {
      return rejectResponse(
        response,
        failure('REFETCH_FAILED', 'The current PDF could not be reacquired.')
      );
    }
    const responseType = parseHttpContentType(response.headers.get('content-type'));
    if (responseType !== 'application/pdf' && responseType !== 'application/octet-stream') {
      return rejectResponse(
        response,
        failure('REFETCH_FAILED', 'The current document did not return PDF content.')
      );
    }
    try {
      if (new URL(response.url).href !== requestUrl.href) {
        return rejectResponse(
          response,
          failure('REFETCH_FAILED', 'The current PDF redirected during reacquisition.')
        );
      }
    } catch (error) {
      if (typeof error === 'object' && error && 'success' in error) throw error;
      throw failure('REFETCH_FAILED', 'The current PDF URL could not be verified.');
    }

    const bytes = await readBoundedBody(response, signal);
    if (!hasPdfHeader(new Uint8Array(bytes))) {
      throw failure('REFETCH_FAILED', 'The current document did not return PDF bytes.');
    }
    return { bytes, source };
  }

  function parserHost(
    acquired: AcquiredPdf,
    options: PdfReadOptions,
    capability: string,
    signal: AbortSignal
  ): Promise<PdfReadResult> {
    return new Promise((resolve) => {
      const mount = document.createElement('div');
      mount.setAttribute('aria-hidden', 'true');
      mount.style.cssText =
        'all:initial;position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;overflow:hidden;pointer-events:none';
      const shadow = mount.attachShadow({ mode: 'closed' });
      const iframe = document.createElement('iframe');
      iframe.src = `${chrome.runtime.getURL(WORKER_HOST_PATH)}#${capability}`;
      iframe.style.cssText = 'width:1px;height:1px;border:0';
      shadow.append(iframe);
      (document.documentElement || document).append(mount);

      let settled = false;
      let parserPort: MessagePort | null = null;
      const finish = (result: PdfReadResult) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        parserPort?.close();
        mount.remove();
        resolve(result);
      };
      const cancel = () => {
        parserPort?.postMessage({ type: 'cancel' } satisfies PdfParserMessage);
        finish(failure('CANCELLED', 'PDF extraction was cancelled.'));
      };
      signal.addEventListener('abort', cancel, { once: true });

      iframe.addEventListener(
        'load',
        () => {
          if (signal.aborted || !iframe.contentWindow) {
            cancel();
            return;
          }
          const channel = new MessageChannel();
          parserPort = channel.port1;
          parserPort.onmessage = ({ data }: MessageEvent<PdfReadResult>) => finish(data);
          parserPort.start();
          iframe.contentWindow.postMessage(
            { token: capability },
            chrome.runtime.getURL('/').slice(0, -1),
            [channel.port2]
          );
          parserPort.postMessage(
            {
              type: 'parse',
              bytes: acquired.bytes,
              options,
              source: acquired.source,
            } satisfies PdfParserMessage,
            [acquired.bytes]
          );
        },
        { once: true }
      );
      iframe.addEventListener(
        'error',
        () => finish(failure('PDF_READER_REQUIRED', 'The local PDF reader could not start.')),
        { once: true }
      );
    });
  }

  function normalizeFailure(error: unknown, signal: AbortSignal): PdfFailure {
    if (signal.aborted) return failure('CANCELLED', 'PDF extraction was cancelled.');
    if (
      error &&
      typeof error === 'object' &&
      'success' in error &&
      (error as { success?: unknown }).success === false
    ) {
      return error as PdfFailure;
    }
    return failure('REFETCH_FAILED', 'The current PDF could not be reacquired.');
  }

  function handlePort(port: chrome.runtime.Port, state: HostState): void {
    if (!port.name.startsWith(PDF_HOST_PORT_PREFIX)) return;
    state.activePorts.add(port);
    const controller = new AbortController();
    let started = false;
    let completed = false;

    const cleanup = () => {
      state.activePorts.delete(port);
      controller.abort();
    };
    port.onDisconnect.addListener(cleanup);
    port.onMessage.addListener(async (message: PdfHostControlMessage) => {
      if (message?.type === 'cancel') {
        controller.abort();
        return;
      }
      if (message?.type !== 'start' || started) return;
      started = true;

      let result: PdfReadResult;
      try {
        const acquired = await acquirePdf(controller.signal);
        result = await parserHost(acquired, message.options, message.capability, controller.signal);
      } catch (error) {
        result = normalizeFailure(error, controller.signal);
      }

      if (controller.signal.aborted || completed) return;
      completed = true;
      try {
        port.postMessage({ type: 'result', result } satisfies PdfHostMessage);
      } catch {
        // The exact document route disappeared before settlement.
      }
    });

    port.postMessage({ type: 'ready' } satisfies PdfHostMessage);
  }

  const isolatedGlobal = globalThis as typeof globalThis & { [HOST_STATE_KEY]?: HostState };
  if (!isolatedGlobal[HOST_STATE_KEY]) {
    const state: HostState = { activePorts: new Set() };
    isolatedGlobal[HOST_STATE_KEY] = state;
    chrome.runtime.onConnect.addListener((port) => handlePort(port, state));
  }
})();
