'use webmcp-tool v1';

export const metadata = {
  name: 'video_context',
  namespace: 'google_drive',
  version: '0.4.1',
  description:
    'Extract transcript from Drive video with timestamps. Returns title, video ID, and segments with start/end times. Requires captions (auto-generated or uploaded). Always prefer this over generic page tools for Drive videos.',
  match: 'https://drive.google.com/*',
  inputSchema: {
    type: 'object',
    properties: {
      language: {
        type: 'string',
        description: 'Transcript language code. Default: en',
        default: 'en',
      },
    },
    additionalProperties: false,
  },
};

export async function execute(args = {}) {
  const { language = 'en' } = args;

  const videoId = getVideoId();
  if (!videoId) {
    throw new Error('Could not extract video ID from URL.');
  }

  // Extract title from page
  const title = document.title
    .replace(/ - Captions - Google Drive$/, '')
    .replace(/ - Google Drive$/, '')
    .trim();

  let segments;

  // Check video info first to determine best caption source
  // cc_asr=1 means ASR captions exist and player endpoint will work
  const videoInfo = await getVideoInfo(videoId);

  if (videoInfo?.ccAsr && videoInfo?.ttsurl) {
    // Player endpoint - works when export API returns 403
    segments = await fetchPlayerCaptions(videoInfo.ttsurl, language);
  }

  // Fallback: export API (for Drive-native captions without ASR flag)
  if (!segments || segments.length === 0) {
    segments = await fetchExportCaptions(videoId, language);
  }

  if (!segments || segments.length === 0) {
    throw new Error(
      'No captions available for this video. To generate captions:\n' +
        '1. Right-click the video in Google Drive\n' +
        '2. Select "Manage caption tracks"\n' +
        '3. Click "Generate automatic captions"\n' +
        '4. Wait a few minutes for processing to complete\n' +
        '5. Try this tool again'
    );
  }

  const totalDuration = segments[segments.length - 1]?.end || 0;

  return {
    content: [{ type: 'json', json: { title, videoId, segments } }],
    metadata: {
      videoId,
      title,
      language,
      segmentCount: segments.length,
      totalDuration,
    },
  };
}

/** Fetches video metadata including caption availability and ttsurl. */
async function getVideoInfo(videoId) {
  try {
    const resp = await fetch(`/u/0/get_video_info?docid=${videoId}`, {
      credentials: 'include',
    });
    if (!resp.ok) return null;

    const params = new URLSearchParams(await resp.text());
    return {
      ccAsr: params.get('cc_asr') === '1',
      ttsurl: params.get('ttsurl'),
    };
  } catch {
    return null;
  }
}

/** Fetches captions via player's timedtext endpoint (requires ttsurl from getVideoInfo). */
async function fetchPlayerCaptions(ttsurl, language) {
  try {
    const url = new URL(ttsurl);
    url.searchParams.set('type', 'track');
    url.searchParams.set('lang', language);
    url.searchParams.set('kind', 'asr');
    url.searchParams.set('name', '');
    url.searchParams.set('fmt', 'json3');

    const resp = await fetch(url.toString(), { credentials: 'include' });
    if (!resp.ok) return null;

    return parseJSON3(await resp.json());
  } catch {
    return null;
  }
}

/** Fetches captions via Drive's export API (works for Drive-native captions). */
async function fetchExportCaptions(videoId, language) {
  try {
    const url = `https://drive.google.com/uc?authuser=0&ttlang=${language}&ttkind=asr&id=${videoId}&export=timedtext`;
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) return null;

    const vtt = await resp.text();
    if (!vtt.startsWith('WEBVTT')) return null;

    return parseVTT(vtt);
  } catch {
    return null;
  }
}

function getVideoId() {
  // From captions edit page: ?id=XXX
  const urlParams = new URLSearchParams(window.location.search);
  const id = urlParams.get('id');
  if (id) return id;

  // From file view page: /file/d/XXX/view
  const pathMatch = window.location.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (pathMatch) return pathMatch[1];

  // From folder view with video preview: element with data-doc-id
  const videoContainer = document.querySelector('[data-doc-id]');
  if (videoContainer?.dataset?.docId) return videoContainer.dataset.docId;

  return null;
}

function parseVTT(vtt) {
  const segments = [];
  const lines = vtt.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Look for timestamp line: 00:00:00.000 --> 00:00:08.960
    const timeMatch = line.match(/^(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/);
    if (timeMatch) {
      const start = parseTimestamp(timeMatch[1]);
      const end = parseTimestamp(timeMatch[2]);

      // Collect text lines until empty line
      const textLines = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i].trim());
        i++;
      }

      if (textLines.length > 0) {
        segments.push({
          start,
          end,
          text: textLines.join(' '),
        });
      }
    }
    i++;
  }

  return segments;
}

function parseTimestamp(ts) {
  const [h, m, s] = ts.split(':');
  return parseFloat(h) * 3600 + parseFloat(m) * 60 + parseFloat(s);
}

/**
 * Parses YouTube/Drive JSON3 caption format.
 * Format: { events: [{ tStartMs, dDurationMs?, segs: [{ utf8 }] }] }
 */
function parseJSON3(data) {
  if (!data?.events) return [];

  const segments = [];
  for (const event of data.events) {
    if (!event.segs) continue;

    const text = event.segs.map((s) => s.utf8 || '').join('');
    if (!text.trim()) continue;

    const start = (event.tStartMs || 0) / 1000;
    const duration = (event.dDurationMs || 0) / 1000;

    segments.push({
      start,
      end: start + duration,
      text: text.trim(),
    });
  }

  return segments;
}
