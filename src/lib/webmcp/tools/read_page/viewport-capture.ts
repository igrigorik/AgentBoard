import { withAbortReason } from './abort';
import {
  PAGE_IMAGE_JPEG_QUALITY,
  PAGE_IMAGE_MAX_BYTES_PER_CALL,
  PAGE_IMAGE_MEDIA_TYPE,
  boundedImageSize,
} from './image-budget';
import type { ExactDocumentRoute } from './route';

export interface ViewportCapture {
  /** Model-only base64 JPEG payload; must never enter the public tool result. */
  data: string;
  mediaType: typeof PAGE_IMAGE_MEDIA_TYPE;
  width: number;
  height: number;
}

export type ViewportCaptureOutcome =
  | { capture: ViewportCapture; warning?: never }
  | { capture?: never; warning: string };

/**
 * Every reason is non-retryable in place: re-capturing the same viewport reproduces
 * the same outcome, so one token with the reason as detail is the honest shape.
 */
export type ViewportUnavailableReason =
  | 'inactive-tab'
  | 'capture-failed'
  | 'navigated'
  | 'too-large';

/** Single owner of the warning vocabulary; callers must not spell these strings. */
export function viewportUnavailable(reason: ViewportUnavailableReason): string {
  return `VIEWPORT_UNAVAILABLE:${reason}`;
}

function unavailable(reason: ViewportUnavailableReason): ViewportCaptureOutcome {
  return { warning: viewportUnavailable(reason) };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return globalThis.btoa(binary);
}

/**
 * Capture the bound tab's visible viewport as one bounded JPEG.
 *
 * chrome.tabs.captureVisibleTab photographs the ACTIVE tab of a window, not an
 * arbitrary tabId. Capturing while the bound tab is inactive would photograph
 * whatever tab the user switched to — a privacy bug, not a degraded result — so
 * tab identity is verified before AND after the capture, and ambiguity discards
 * the image. Capture failures degrade to a warning; only caller aborts throw.
 */
export async function captureViewport(
  route: ExactDocumentRoute,
  abortSignal?: AbortSignal
): Promise<ViewportCaptureOutcome> {
  let windowId: number;
  try {
    const tab = await withAbortReason(chrome.tabs.get(route.tabId), abortSignal);
    if (!tab.active || typeof tab.windowId !== 'number') return unavailable('inactive-tab');
    windowId = tab.windowId;
  } catch {
    if (abortSignal?.aborted) throw abortSignal.reason;
    return unavailable('inactive-tab');
  }

  let dataUrl: string;
  try {
    // PNG here keeps the pipeline single-lossy: the only JPEG quantization happens
    // in our own bounded re-encode below.
    dataUrl = await withAbortReason(
      chrome.tabs.captureVisibleTab(windowId, { format: 'png' }),
      abortSignal
    );
  } catch {
    if (abortSignal?.aborted) throw abortSignal.reason;
    return unavailable('capture-failed');
  }

  // Re-verify identity after the capture: a tab switch or navigation during the
  // async gap means the pixels may not belong to the bound document.
  try {
    const tab = await withAbortReason(chrome.tabs.get(route.tabId), abortSignal);
    if (!tab.active || tab.windowId !== windowId) return unavailable('inactive-tab');
    if (!(await route.isCurrent(abortSignal))) return unavailable('navigated');
  } catch {
    if (abortSignal?.aborted) throw abortSignal.reason;
    return unavailable('inactive-tab');
  }

  try {
    const source = await globalThis.createImageBitmap(
      await (await globalThis.fetch(dataUrl)).blob()
    );
    try {
      abortSignal?.throwIfAborted();
      // Raster source: never upscale a screenshot, which would spend bytes on
      // resampled pixels that carry no additional detail.
      const { width, height } = boundedImageSize(source.width, source.height, {
        allowUpscale: false,
      });
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) return unavailable('capture-failed');
      context.drawImage(source, 0, 0, width, height);
      const encoded = await canvas.convertToBlob({
        type: PAGE_IMAGE_MEDIA_TYPE,
        quality: PAGE_IMAGE_JPEG_QUALITY,
      });
      abortSignal?.throwIfAborted();
      if (encoded.size > PAGE_IMAGE_MAX_BYTES_PER_CALL) return unavailable('too-large');
      const bytes = new Uint8Array(await encoded.arrayBuffer());
      abortSignal?.throwIfAborted();
      return {
        capture: { data: toBase64(bytes), mediaType: PAGE_IMAGE_MEDIA_TYPE, width, height },
      };
    } finally {
      source.close();
    }
  } catch {
    if (abortSignal?.aborted) throw abortSignal.reason;
    return unavailable('capture-failed');
  }
}
