import { afterEach, describe, expect, it, vi } from 'vitest';
import { execute } from '../src/lib/webmcp/tools/youtube_transcript/script.js';

describe('YouTube transcript execution context', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, '', '/');
    document.head.innerHTML = '';
  });

  it('reads the current video ID for every execution after same-document navigation', async () => {
    document.head.innerHTML =
      '<script>window.ytcfg = {"INNERTUBE_API_KEY":"test-api-key"};</script>';
    const requestedVideoIds: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/youtubei/v1/player')) {
          const body = JSON.parse(String(init?.body)) as { videoId: string };
          requestedVideoIds.push(body.videoId);
          return new Response(
            JSON.stringify({
              videoDetails: { videoId: body.videoId, title: `Video ${body.videoId}` },
              captions: {
                playerCaptionsTracklistRenderer: {
                  captionTracks: [
                    {
                      baseUrl: `https://captions.example/${body.videoId}`,
                      languageCode: 'en',
                      name: { simpleText: 'English' },
                    },
                  ],
                },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }

        return new Response(
          JSON.stringify({
            events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: url }] }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      })
    );

    window.history.replaceState({}, '', '/watch?v=video-a');
    const first = await execute({ format: 'text' });
    window.history.replaceState({}, '', '/watch?v=video-b');
    const second = await execute({ format: 'text' });

    expect(requestedVideoIds).toEqual(['video-a', 'video-b']);
    expect(first.metadata.videoId).toBe('video-a');
    expect(first.transcript?.text).toContain('https://captions.example/video-a');
    expect(second.metadata.videoId).toBe('video-b');
    expect(second.transcript?.text).toContain('https://captions.example/video-b');
  });
});
