import { PDF_MAX_BYTES, type PdfFailure, type PdfParserRequest } from './protocol';

class PdfByteLimitError extends Error {}

// Module-private on purpose: the content-script document host must stay a self-contained
// classic IIFE, so this bounded-read policy is duplicated there rather than shared.
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

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response may already be closed by the browser or network stack.
  }
}

/** Read one response under the shared PDF input bound without buffering an unbounded body. */
async function readBoundedBody(response: Response, signal: AbortSignal): Promise<ArrayBuffer> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > PDF_MAX_BYTES) {
    throw new PdfByteLimitError('PDF input exceeds its byte limit');
  }
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > PDF_MAX_BYTES) {
      throw new PdfByteLimitError('PDF input exceeds its byte limit');
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
        throw new PdfByteLimitError('PDF input exceeds its byte limit');
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

function failure(code: PdfFailure['error']['code'], message: string): PdfFailure {
  return { success: false, error: { code, message } };
}

/** Acquire parser bytes directly for local files; network bytes arrive from the document host. */
export async function acquireParserBytes(
  request: PdfParserRequest,
  signal: AbortSignal
): Promise<{ bytes?: ArrayBuffer; failure?: PdfFailure }> {
  if ('bytes' in request && request.bytes instanceof ArrayBuffer) {
    return { bytes: request.bytes };
  }

  const localFileUrl = request.localFileUrl;
  if (typeof localFileUrl !== 'string') {
    return { failure: failure('PARSE_FAILED', 'The PDF parser request was invalid.') };
  }

  let response: Response;
  try {
    response = await globalThis.fetch(localFileUrl, {
      credentials: 'omit',
      redirect: 'error',
      signal,
    });
  } catch {
    return {
      failure: signal.aborted
        ? failure('CANCELLED', 'PDF extraction was cancelled.')
        : failure('REFETCH_FAILED', 'The local PDF could not be read.'),
    };
  }

  if (!response.ok || response.redirected || response.url !== localFileUrl) {
    await cancelResponse(response);
    return { failure: failure('REFETCH_FAILED', 'The local PDF could not be read.') };
  }
  const responseType = response.headers.get('content-type');
  if (responseType !== null && responseType.trim().toLowerCase() !== 'application/pdf') {
    await cancelResponse(response);
    return { failure: failure('REFETCH_FAILED', 'The local file did not contain PDF content.') };
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await readBoundedBody(response, signal);
  } catch (error) {
    if (error instanceof PdfByteLimitError) {
      await cancelResponse(response);
      return { failure: failure('TOO_LARGE', 'This PDF exceeds the input byte limit.') };
    }
    return {
      failure: signal.aborted
        ? failure('CANCELLED', 'PDF extraction was cancelled.')
        : failure('REFETCH_FAILED', 'The local PDF could not be read.'),
    };
  }
  if (!hasPdfHeader(new Uint8Array(bytes))) {
    return { failure: failure('REFETCH_FAILED', 'The local file did not contain PDF bytes.') };
  }
  return { bytes };
}
