import { afterEach, describe, expect, it, vi } from 'vitest';
import { execute } from '../src/lib/webmcp/tools/youtube_transcript/script.js';

const ASR_EN_TRACK_PARAMS = 'CgNhc3ISAmVuGgA%3D';
const MANUAL_EN_TRACK_PARAMS = 'CgASAmVuGgA%3D';

type DataElement<T> = HTMLElement & { data: T };

function captionTrack(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: 'https://www.youtube.com/api/timedtext?v=current-video',
    languageCode: 'en',
    name: { simpleText: 'English' },
    trackName: '',
    ...overrides,
  };
}

function playerResponse(videoId: string, tracks?: Array<Record<string, unknown>>) {
  const resolvedTracks = tracks ?? [
    captionTrack({ baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}` }),
  ];
  return {
    videoDetails: {
      videoId,
      title: `Video ${videoId}`,
      author: 'Test Author',
      lengthSeconds: '120',
    },
    captions: {
      playerCaptionsTracklistRenderer: { captionTracks: resolvedTracks },
    },
  };
}

function installPlayer(getResponse: () => unknown) {
  document.body.innerHTML = '<div id="movie_player"></div>';
  Object.assign(document.getElementById('movie_player')!, {
    getPlayerResponse: vi.fn(getResponse),
  });
}

function installInitialPlayerResponse(response: unknown) {
  Object.defineProperty(window, 'ytInitialPlayerResponse', {
    configurable: true,
    value: response,
  });
}

function timedTextResponse(text: string) {
  return new Response(
    JSON.stringify({
      events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: text }] }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

function transcriptItems(videoId: string, trackParams = ASR_EN_TRACK_PARAMS) {
  return [
    {
      transcriptSectionHeaderRenderer: {
        sectionHeader: { runs: [{ text: 'Chapter heading' }] },
      },
    },
    {
      transcriptSegmentRenderer: {
        startMs: '2639',
        endMs: '8480',
        snippet: { runs: [{ text: 'Thanks for ' }, { text: 'doing this.' }] },
        targetId: `${videoId}.${trackParams}.2639.8480`,
      },
    },
    {
      transcriptSegmentRenderer: {
        startMs: '8480',
        endMs: '14000',
        snippet: { simpleText: 'Second segment' },
        targetId: `${videoId}.${trackParams}.8480.14000`,
      },
    },
    {
      transcriptSegmentRenderer: {
        startMs: '14000',
        endMs: '19000',
        snippet: { simpleText: 'Stale segment' },
        targetId: `different-video.${trackParams}.14000.19000`,
      },
    },
  ];
}

function appendTranscriptPanel(
  videoId: string,
  options: {
    expanded?: boolean;
    trackParams?: string;
    items?: ReturnType<typeof transcriptItems>;
  } = {}
) {
  const panel = document.createElement('ytd-engagement-panel-section-list-renderer');
  panel.setAttribute('target-id', 'engagement-panel-searchable-transcript');
  panel.setAttribute(
    'visibility',
    options.expanded === false
      ? 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN'
      : 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED'
  );

  const visibilityButton = document.createElement('div');
  visibilityButton.id = 'visibility-button';
  const closeButton = document.createElement('button');
  const close = vi.fn(() => panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN'));
  closeButton.addEventListener('click', close);
  visibilityButton.append(closeButton);

  const list = document.createElement('ytd-transcript-segment-list-renderer') as DataElement<{
    initialSegments: ReturnType<typeof transcriptItems>;
  }>;
  list.data = {
    initialSegments: options.items ?? transcriptItems(videoId, options.trackParams),
  };
  panel.append(visibilityButton, list);
  document.body.append(panel);
  return { panel, list, close };
}

function installTranscriptTrigger(onClick: () => void) {
  const renderer = document.createElement('ytd-button-renderer') as DataElement<{
    command: unknown;
  }>;
  renderer.data = {
    command: {
      commandExecutorCommand: {
        commands: [
          {
            updateEngagementPanelContentCommand: {
              contentSourcePanelIdentifier: {
                tag: 'engagement-panel-searchable-transcript',
              },
            },
          },
        ],
      },
    },
  };
  const button = document.createElement('button');
  const click = vi.fn(onClick);
  button.addEventListener('click', click);
  renderer.append(button);
  document.body.append(renderer);
  return { renderer, click };
}

function installExpandedNonTranscriptPanel() {
  const panel = document.createElement('ytd-engagement-panel-section-list-renderer');
  panel.setAttribute('target-id', 'engagement-panel-chapters');
  panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
  document.body.append(panel);
  return panel;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  delete (window as typeof window & { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse;
});

describe('YouTube transcript execution context', () => {
  it('prefers the live player response for the current video', async () => {
    window.history.replaceState({}, '', '/watch?v=current-video');
    installPlayer(() => playerResponse('current-video'));
    installInitialPlayerResponse(playerResponse('stale-video'));

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/timedtext')) return timedTextResponse('Current transcript');
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await execute({ format: 'text' });

    expect(result.metadata.videoId).toBe('current-video');
    expect(result.transcript?.text).toBe('Current transcript');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses a matching initial response when the live player is stale', async () => {
    window.history.replaceState({}, '', '/watch?v=current-video');
    installPlayer(() => playerResponse('stale-video'));
    installInitialPlayerResponse(playerResponse('current-video'));

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/timedtext')) return timedTextResponse('Initial transcript');
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await execute({ format: 'text' });

    expect(result.metadata.videoId).toBe('current-video');
    expect(result.transcript?.text).toBe('Initial transcript');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads the live player response again after same-document navigation', async () => {
    let currentResponse = playerResponse('video-a');
    installPlayer(() => currentResponse);
    const requestedVideoIds: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        requestedVideoIds.push(url.searchParams.get('v') || 'missing');
        return timedTextResponse(url.searchParams.get('v') || 'missing');
      })
    );

    window.history.replaceState({}, '', '/watch?v=video-a');
    const first = await execute({ format: 'text' });
    currentResponse = playerResponse('video-b');
    window.history.replaceState({}, '', '/watch?v=video-b');
    const second = await execute({ format: 'text' });

    expect(requestedVideoIds).toEqual(['video-a', 'video-b']);
    expect(first.metadata.videoId).toBe('video-a');
    expect(first.transcript?.text).toBe('video-a');
    expect(second.metadata.videoId).toBe('video-b');
    expect(second.transcript?.text).toBe('video-b');
  });

  it.each([
    ['an empty successful response', '', 200],
    ['malformed JSON', 'not-json', 200],
    ['a parsed response without events', JSON.stringify({ events: [] }), 200],
    ['a non-success response', 'forbidden', 403],
  ])('uses the reversible transcript panel fallback after %s', async (_name, body, status) => {
    const videoId = 'CjLhd1WZwTE';
    window.history.replaceState({}, '', `/watch?v=${videoId}`);
    installPlayer(() =>
      playerResponse(videoId, [
        captionTrack({
          baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}`,
          kind: 'asr',
          name: { simpleText: 'English (auto-generated)' },
        }),
      ])
    );

    let panel: ReturnType<typeof appendTranscriptPanel> | undefined;
    const trigger = installTranscriptTrigger(() => {
      panel = appendTranscriptPanel(videoId);
    });
    const fetchMock = vi.fn(async () => new Response(body, { status }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await execute();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(trigger.click).toHaveBeenCalledTimes(1);
    expect(panel?.close).toHaveBeenCalledTimes(1);
    expect(panel?.panel.getAttribute('visibility')).toBe('ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
    expect(result.transcript).toMatchObject({
      language: 'en',
      isAutoGenerated: true,
      segmentCount: 2,
      segments: [
        { start: 2.639, duration: 5.841, text: 'Thanks for doing this.' },
        { start: 8.48, duration: 5.52, text: 'Second segment' },
      ],
    });
  });

  it('reads an already-loaded matching panel without changing its visibility', async () => {
    const videoId = 'CjLhd1WZwTE';
    window.history.replaceState({}, '', `/watch?v=${videoId}`);
    installPlayer(() =>
      playerResponse(videoId, [
        captionTrack({
          baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}`,
          kind: 'asr',
        }),
      ])
    );
    const loaded = appendTranscriptPanel(videoId, { expanded: false });
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await execute({ format: 'text' });

    expect(result.transcript?.text).toBe('Thanks for doing this. Second segment');
    expect(loaded.close).not.toHaveBeenCalled();
    expect(loaded.panel.getAttribute('visibility')).toBe('ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
  });

  it('does not replace a non-transcript engagement panel', async () => {
    const videoId = 'CjLhd1WZwTE';
    window.history.replaceState({}, '', `/watch?v=${videoId}`);
    installPlayer(() =>
      playerResponse(videoId, [
        captionTrack({
          baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}`,
          kind: 'asr',
        }),
      ])
    );
    const existingPanel = installExpandedNonTranscriptPanel();
    const trigger = installTranscriptTrigger(() => appendTranscriptPanel(videoId));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 200 }))
    );

    await expect(execute()).rejects.toThrow('Failed to retrieve transcript from YouTube');

    expect(trigger.click).not.toHaveBeenCalled();
    expect(existingPanel.getAttribute('visibility')).toBe('ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
  });

  it('reads a transcript panel that was already open without claiming its lifecycle', async () => {
    const videoId = 'CjLhd1WZwTE';
    window.history.replaceState({}, '', `/watch?v=${videoId}`);
    installPlayer(() =>
      playerResponse(videoId, [
        captionTrack({
          baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}`,
          kind: 'asr',
        }),
      ])
    );
    const existing = appendTranscriptPanel(videoId, { items: [] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 200 }))
    );

    const pending = execute({ format: 'text' });
    queueMicrotask(() => {
      existing.list.data = { initialSegments: transcriptItems(videoId) };
      existing.list.append(document.createElement('span'));
    });
    const result = await pending;

    expect(result.transcript?.text).toBe('Thanks for doing this. Second segment');
    expect(existing.close).not.toHaveBeenCalled();
    expect(existing.panel.getAttribute('visibility')).toBe('ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
  });

  it('closes its own loading panel after a bounded timeout', async () => {
    vi.useFakeTimers();
    const videoId = 'CjLhd1WZwTE';
    window.history.replaceState({}, '', `/watch?v=${videoId}`);
    installPlayer(() =>
      playerResponse(videoId, [
        captionTrack({
          baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}`,
          kind: 'asr',
        }),
      ])
    );
    let panel: ReturnType<typeof appendTranscriptPanel> | undefined;
    installTranscriptTrigger(() => {
      panel = appendTranscriptPanel(videoId, { items: [] });
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 200 }))
    );

    const assertion = expect(execute()).rejects.toThrow(
      'Failed to retrieve transcript from YouTube'
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;

    expect(panel?.close).toHaveBeenCalledTimes(1);
    expect(panel?.panel.getAttribute('visibility')).toBe('ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
  });

  it('fails without mutating the page when no transcript command is available', async () => {
    const videoId = 'CjLhd1WZwTE';
    window.history.replaceState({}, '', `/watch?v=${videoId}`);
    installPlayer(() =>
      playerResponse(videoId, [
        captionTrack({
          baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}`,
          kind: 'asr',
        }),
      ])
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 200 }))
    );

    await expect(execute()).rejects.toThrow('Failed to retrieve transcript from YouTube');
    expect(document.querySelector('ytd-engagement-panel-section-list-renderer')).toBeNull();
  });

  it('rejects panel data for a different caption track', async () => {
    const videoId = 'CjLhd1WZwTE';
    window.history.replaceState({}, '', `/watch?v=${videoId}`);
    installPlayer(() =>
      playerResponse(videoId, [
        captionTrack({
          baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}`,
          kind: 'asr',
        }),
      ])
    );
    installTranscriptTrigger(() =>
      appendTranscriptPanel(videoId, { trackParams: MANUAL_EN_TRACK_PARAMS })
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 200 }))
    );

    await expect(execute()).rejects.toThrow(
      "YouTube's transcript panel opened a different caption track than requested"
    );
  });

  it('shares one panel load across concurrent calls', async () => {
    const videoId = 'CjLhd1WZwTE';
    window.history.replaceState({}, '', `/watch?v=${videoId}`);
    installPlayer(() =>
      playerResponse(videoId, [
        captionTrack({
          baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}`,
          kind: 'asr',
        }),
      ])
    );

    let panel: ReturnType<typeof appendTranscriptPanel> | undefined;
    const trigger = installTranscriptTrigger(() => {
      queueMicrotask(() => {
        panel = appendTranscriptPanel(videoId);
      });
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 200 }))
    );

    const [first, second] = await Promise.all([execute({ format: 'text' }), execute()]);

    expect(trigger.click).toHaveBeenCalledTimes(1);
    expect(panel?.close).toHaveBeenCalledTimes(1);
    expect(first.transcript?.segmentCount).toBe(2);
    expect(second.transcript?.segmentCount).toBe(2);
  });

  it('rejects transcript data if the page navigates during panel loading', async () => {
    const videoId = 'CjLhd1WZwTE';
    window.history.replaceState({}, '', `/watch?v=${videoId}`);
    installPlayer(() =>
      playerResponse(videoId, [
        captionTrack({
          baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}`,
          kind: 'asr',
        }),
      ])
    );
    installTranscriptTrigger(() => {
      queueMicrotask(() => {
        window.history.replaceState({}, '', '/watch?v=different-video');
        document.body.append(document.createElement('span'));
      });
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 200 }))
    );

    await expect(execute()).rejects.toThrow('Failed to retrieve transcript from YouTube');
  });
});
