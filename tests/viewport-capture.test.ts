/**
 * Unit coverage for the SW-side viewport capture primitive.
 *
 * chrome.tabs.captureVisibleTab photographs the ACTIVE tab of a window, so tab
 * identity is a privacy boundary here: every ambiguity must discard the image.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureViewport } from '../src/lib/webmcp/tools/read_page/viewport-capture';
import type { ExactDocumentRoute } from '../src/lib/webmcp/tools/read_page/route';

function route(isCurrent = vi.fn(async () => true)): ExactDocumentRoute {
  return { tabId: 7, documentId: 'doc-1', isCurrent };
}

function stubCaptureEnvironment({ width = 2560, height = 1440, encodedSize = 50_000 } = {}) {
  const encoded = new Uint8Array(encodedSize).fill(65);
  // jsdom's Blob lacks arrayBuffer(); fake the exact encode contract the code consumes.
  const convertToBlob = vi.fn(
    async () =>
      ({ size: encoded.byteLength, arrayBuffer: async () => encoded.buffer.slice(0) }) as Blob
  );
  const drawImage = vi.fn();
  const canvases: Array<{ width: number; height: number }> = [];
  class FakeOffscreenCanvas {
    width: number;
    height: number;
    constructor(canvasWidth: number, canvasHeight: number) {
      this.width = canvasWidth;
      this.height = canvasHeight;
      canvases.push(this);
    }
    getContext() {
      return { drawImage };
    }
    convertToBlob = convertToBlob;
  }
  const close = vi.fn();
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width, height, close }))
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ blob: async () => ({}) as Blob }))
  );
  return { canvases, convertToBlob, drawImage, close };
}

function stubChrome(
  tabs: Array<{ active: boolean; windowId: number }>,
  dataUrl = 'data:image/png;base64,AAAA'
) {
  const get = vi.fn();
  for (const tab of tabs) get.mockResolvedValueOnce(tab);
  const captureVisibleTab = vi.fn(async () => dataUrl);
  vi.stubGlobal('chrome', { tabs: { get, captureVisibleTab } });
  return { get, captureVisibleTab };
}

describe('viewport capture', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('never captures when the bound tab is not the active tab', async () => {
    const { captureVisibleTab } = stubChrome([{ active: false, windowId: 5 }]);

    await expect(captureViewport(route())).resolves.toEqual({
      warning: 'VIEWPORT_UNAVAILABLE:inactive-tab',
    });
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });

  it('captures, downscales to the shared image budget, and releases the bitmap', async () => {
    const env = stubCaptureEnvironment({ width: 2560, height: 1440 });
    const { captureVisibleTab } = stubChrome([
      { active: true, windowId: 5 },
      { active: true, windowId: 5 },
    ]);

    const outcome = await captureViewport(route());

    expect(captureVisibleTab).toHaveBeenCalledWith(5, { format: 'png' });
    expect(env.canvases).toEqual([expect.objectContaining({ width: 1024, height: 576 })]);
    expect(outcome.capture).toMatchObject({ mediaType: 'image/jpeg', width: 1024, height: 576 });
    expect(outcome.capture?.data).toBe(btoa('A'.repeat(50_000)));
    expect(env.close).toHaveBeenCalled();
  });

  it('caps portrait captures on the longest edge', async () => {
    const env = stubCaptureEnvironment({ width: 800, height: 3000 });
    stubChrome([
      { active: true, windowId: 5 },
      { active: true, windowId: 5 },
    ]);

    const outcome = await captureViewport(route());

    expect(outcome.capture).toMatchObject({ width: 273, height: 1024 });
    expect(env.canvases[0]).toMatchObject({ width: 273, height: 1024 });
  });

  it('discards the capture when the tab moved or deactivated during the async gap', async () => {
    stubCaptureEnvironment();
    stubChrome([
      { active: true, windowId: 5 },
      { active: true, windowId: 9 },
    ]);

    await expect(captureViewport(route())).resolves.toEqual({
      warning: 'VIEWPORT_UNAVAILABLE:inactive-tab',
    });
  });

  it('discards the capture when the exact document route was replaced', async () => {
    stubCaptureEnvironment();
    stubChrome([
      { active: true, windowId: 5 },
      { active: true, windowId: 5 },
    ]);

    await expect(captureViewport(route(vi.fn(async () => false)))).resolves.toEqual({
      warning: 'VIEWPORT_UNAVAILABLE:navigated',
    });
  });

  it('degrades capture API failures, including quota exhaustion, to a warning', async () => {
    stubCaptureEnvironment();
    const get = vi.fn(async () => ({ active: true, windowId: 5 }));
    // Chromium enforces a sustained MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND limit;
    // a missing screenshot is an acceptable degradation, never a failed read.
    const captureVisibleTab = vi.fn(async () => {
      throw new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');
    });
    vi.stubGlobal('chrome', { tabs: { get, captureVisibleTab } });

    await expect(captureViewport(route())).resolves.toEqual({
      warning: 'VIEWPORT_UNAVAILABLE:capture-failed',
    });
    expect(captureVisibleTab).toHaveBeenCalledTimes(1);
  });

  it('rejects an encoded image beyond the aggregate media budget', async () => {
    stubCaptureEnvironment({ encodedSize: 7 * 1024 * 1024 });
    stubChrome([
      { active: true, windowId: 5 },
      { active: true, windowId: 5 },
    ]);

    await expect(captureViewport(route())).resolves.toEqual({
      warning: 'VIEWPORT_UNAVAILABLE:too-large',
    });
  });

  it('throws the caller abort reason instead of a warning', async () => {
    stubCaptureEnvironment();
    stubChrome([{ active: true, windowId: 5 }]);
    const controller = new AbortController();
    const reason = new DOMException('caller cancelled', 'AbortError');
    controller.abort(reason);

    await expect(captureViewport(route(), controller.signal)).rejects.toBe(reason);
  });
});
