'use webmcp-tool v1';

export const metadata = {
  name: 'video_context',
  namespace: 'google_drive',
  version: '0.2.0',
  description:
    'Extract transcript from a Google Drive video. Returns timestamped segments.',
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

  // Fetch transcript via timedtext export
  const transcriptUrl = `https://drive.google.com/uc?authuser=0&ttlang=${language}&ttkind=asr&id=${videoId}&export=timedtext`;

  const response = await fetch(transcriptUrl, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`Failed to fetch transcript: ${response.status}`);
  }

  const vttContent = await response.text();

  if (!vttContent.startsWith('WEBVTT')) {
    throw new Error('No transcript available for this video. Does it have auto-generated captions?');
  }

  // Parse VTT into segments
  const segments = parseVTT(vttContent);

  if (segments.length === 0) {
    throw new Error('Transcript is empty.');
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
