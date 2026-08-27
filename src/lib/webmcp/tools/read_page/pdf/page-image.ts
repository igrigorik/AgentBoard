import type { PDFPageProxy, RenderTask } from 'pdfjs-dist';
import {
  PDF_PAGE_IMAGE_JPEG_QUALITY,
  PDF_PAGE_IMAGE_MAX_EDGE,
  PDF_PAGE_IMAGE_MAX_PIXELS,
  PDF_PAGE_IMAGE_MEDIA_TYPE,
  type PdfEncodedPageImage,
} from './protocol';

export interface PdfPageImageResources {
  cancelled: boolean;
  renderTask?: RenderTask;
  canvas?: HTMLCanvasElement;
  fileReader?: FileReader;
}

export class PdfPageImageLimitError extends Error {}

export function releaseCanvas(canvas: HTMLCanvasElement | undefined): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function encodedJpeg(
  canvas: HTMLCanvasElement,
  resources: PdfPageImageResources,
  maxBytes: number
): Promise<{ data: string; byteLength: number }> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (resources.cancelled) {
          reject(new DOMException('PDF extraction was cancelled', 'AbortError'));
          return;
        }
        if (!blob || blob.type !== PDF_PAGE_IMAGE_MEDIA_TYPE) {
          reject(new Error('PDF page image encoding failed'));
          return;
        }
        if (blob.size > maxBytes) {
          reject(new PdfPageImageLimitError('PDF page image exceeds the media byte limit'));
          return;
        }

        const reader = new FileReader();
        resources.fileReader = reader;
        const cleanup = () => {
          if (resources.fileReader === reader) resources.fileReader = undefined;
        };
        reader.onerror = () => {
          cleanup();
          reject(new Error('PDF page image encoding failed'));
        };
        reader.onabort = () => {
          cleanup();
          reject(new DOMException('PDF extraction was cancelled', 'AbortError'));
        };
        reader.onload = () => {
          cleanup();
          if (resources.cancelled) {
            reject(new DOMException('PDF extraction was cancelled', 'AbortError'));
            return;
          }
          const result = reader.result;
          const prefix = `data:${PDF_PAGE_IMAGE_MEDIA_TYPE};base64,`;
          if (typeof result !== 'string' || !result.startsWith(prefix)) {
            reject(new Error('PDF page image encoding failed'));
            return;
          }
          resolve({ data: result.slice(prefix.length), byteLength: blob.size });
        };
        reader.readAsDataURL(blob);
      },
      PDF_PAGE_IMAGE_MEDIA_TYPE,
      PDF_PAGE_IMAGE_JPEG_QUALITY
    );
  });
}

interface RenderFrameScheduler {
  dispose(): void;
}

/**
 * Preserve PDF.js display intent while replacing hidden-frame requestAnimationFrame with a
 * MessageChannel task queue. Print intent can alter optional-content visibility.
 */
function installRenderFrameScheduler(): RenderFrameScheduler {
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const channel = new MessageChannel();
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 1;

  channel.port1.onmessage = ({ data }: MessageEvent<number>) => {
    const callback = callbacks.get(data);
    if (!callback) return;
    callbacks.delete(data);
    callback(globalThis.performance.now());
  };
  channel.port1.start();
  globalThis.requestAnimationFrame = (callback) => {
    const id = nextId;
    nextId += 1;
    callbacks.set(id, callback);
    channel.port2.postMessage(id);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => callbacks.delete(id);

  return {
    dispose() {
      globalThis.requestAnimationFrame = originalRequest;
      globalThis.cancelAnimationFrame = originalCancel;
      callbacks.clear();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

export async function renderPageImage(
  page: PDFPageProxy,
  pageNumber: number,
  imageIndex: number,
  maxEncodedBytes: number,
  resources: PdfPageImageResources
): Promise<PdfEncodedPageImage> {
  const baseViewport = page.getViewport({ scale: 1 });
  const width = baseViewport.width;
  const height = baseViewport.height;
  const area = width * height;
  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0 ||
    !Number.isFinite(area) ||
    area <= 0
  ) {
    throw new Error('PDF page dimensions are invalid');
  }

  const boundedScale = Math.min(
    PDF_PAGE_IMAGE_MAX_EDGE / Math.max(width, height),
    Math.sqrt(PDF_PAGE_IMAGE_MAX_PIXELS / area)
  );
  const pixelWidth = Math.max(1, Math.floor(width * boundedScale));
  const pixelHeight = Math.max(1, Math.floor(height * boundedScale));
  const renderScale = Math.min(pixelWidth / width, pixelHeight / height);
  if (
    !Number.isFinite(renderScale) ||
    renderScale <= 0 ||
    Math.max(pixelWidth, pixelHeight) > PDF_PAGE_IMAGE_MAX_EDGE ||
    pixelWidth * pixelHeight > PDF_PAGE_IMAGE_MAX_PIXELS
  ) {
    throw new Error('PDF page dimensions are invalid');
  }

  const canvas = document.createElement('canvas');
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  resources.canvas = canvas;
  try {
    const frameScheduler = installRenderFrameScheduler();
    try {
      const renderTask = page.render({
        canvas,
        viewport: page.getViewport({ scale: renderScale }),
        intent: 'display',
        background: '#fff',
      });
      resources.renderTask = renderTask;
      try {
        await renderTask.promise;
      } finally {
        if (resources.renderTask === renderTask) resources.renderTask = undefined;
      }
    } finally {
      frameScheduler.dispose();
    }
    if (resources.cancelled) {
      throw new DOMException('PDF extraction was cancelled', 'AbortError');
    }

    const encoded = await encodedJpeg(canvas, resources, maxEncodedBytes);
    return {
      imageIndex,
      pageNumber,
      width: pixelWidth,
      height: pixelHeight,
      mediaType: PDF_PAGE_IMAGE_MEDIA_TYPE,
      detail: 'low',
      ...encoded,
    };
  } finally {
    if (resources.canvas === canvas) resources.canvas = undefined;
    releaseCanvas(canvas);
  }
}
