'use webmcp-tool v1';

export const metadata = {
  name: 'document_context',
  namespace: 'google_docs',
  version: '0.5.0',
  description:
    'Extract content, selection, comments, and document structure from the current Google Doc. Returns document text, selected text with position, comments with anchor text, and full outline with current reading position.',
  match: 'https://docs.google.com/document/*',
  inputSchema: {
    type: 'object',
    properties: {
      includeFullText: {
        type: 'boolean',
        description: 'Include full document text in response. Default: true',
        default: true,
      },
      includeComments: {
        type: 'boolean',
        description: 'Fetch and include comments. Default: true',
        default: true,
      },
    },
    additionalProperties: false,
  },
};

export async function execute(args = {}) {
  const { includeFullText = true, includeComments = true } = args;

  const docId = getDocId();
  if (!docId) {
    throw new Error('Could not extract document ID from URL. Are you on a Google Docs page?');
  }

  // Get the annotate API for text and selection
  if (typeof _docs_annotate_getAnnotatedText !== 'function') {
    throw new Error('Google Docs annotate API not available. Page may not be fully loaded.');
  }

  const api = await _docs_annotate_getAnnotatedText();

  const text = api.getText();
  const annotations = api.getAnnotations();
  const selectionRanges = api.getSelection();

  // Extract selected text if there's a selection
  let selection = null;
  if (selectionRanges && selectionRanges.length > 0 && selectionRanges[0]) {
    const range = selectionRanges[0];
    if (range.start !== undefined && range.end !== undefined && range.start !== range.end) {
      selection = {
        start: range.start,
        end: range.end,
        text: text.substring(range.start, range.end),
      };
    }
  }

  // Fetch comments if requested
  let comments = [];
  if (includeComments) {
    try {
      comments = await fetchComments(docId);
    } catch (e) {
      // Comments fetch failed - continue without them
      console.warn('Failed to fetch comments:', e.message);
    }
  }

  // Get document outline (tabs, sections, current position)
  const outlineData = getDocumentOutline();

  // Build current context (most important - what user is looking at right now)
  const context = {
    tab: outlineData.currentTab,
    section: outlineData.currentSection,
    selection,
  };

  // Build outline without redundant currentTab/currentSection
  const outline = {
    tabs: outlineData.tabs,
    sections: outlineData.sections,
  };

  // Build response with context at the top
  const result = {
    context,
    docId,
    url: window.location.href,
    title: document.title.replace(/ - Google Docs$/, ''),
    outline,
    comments,
    annotations: {
      links: annotations.link || [],
    },
    textLength: text.length,
  };

  if (includeFullText) {
    result.text = text;
  }

  return {
    content: [{ type: 'json', json: result }],
    metadata: {
      docId,
      tab: context.tab,
      section: context.section,
      hasSelection: !!selection,
      selectionLength: selection?.text?.length || 0,
      commentCount: comments.length,
    },
  };
}

/**
 * Fetch comments via the internal /docos/p/sync endpoint.
 * Requires auth tokens from _docs_flag_initialData.
 */
async function fetchComments(docId) {
  const initialData = window._docs_flag_initialData;
  if (!initialData?.info_params) {
    throw new Error('Could not find auth tokens in page data');
  }

  const { token, ouid } = initialData.info_params;

  const url = new URL(`https://docs.google.com/document/d/${docId}/docos/p/sync`);
  url.searchParams.set('id', docId);
  url.searchParams.set('token', token);
  url.searchParams.set('ouid', ouid);
  url.searchParams.set('includes_info_params', 'true');
  url.searchParams.set('cros_files', 'false');
  url.searchParams.set('tab', 't.0');

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'x-same-domain': '1',
    },
    body: 'p=[[]]', // Empty sync request returns all comments
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`Comments API returned ${response.status}`);
  }

  const text = await response.text();
  return parseDocosResponse(text);
}

/**
 * Parse the docos sync response format.
 * Response is prefixed with )]}' for XSS protection.
 * Structure: [["sr", [threads...], timestamp], ["di", count]]
 */
function parseDocosResponse(responseText) {
  const jsonStr = responseText.replace(/^\)\]\}'?\n?/, '');
  const data = JSON.parse(jsonStr);

  const comments = [];

  for (const item of data) {
    if (item[0] !== 'sr') continue;

    const threads = item[1];
    for (const thread of threads) {
      const content = thread[1];
      if (!Array.isArray(content)) continue;

      const comment = {
        id: content[0],
        text: content[3]?.[1], // plain text
        author: content[4]?.[0],
        authorId: content[4]?.[3],
        createdAt: content[5],
        modifiedAt: content[6],
        anchorText: content[8]?.[1], // the highlighted text this comment is attached to
        replies: [],
      };

      // Parse replies (index 7)
      const replies = content[7];
      if (Array.isArray(replies)) {
        for (const reply of replies) {
          if (!Array.isArray(reply)) continue;
          // Skip deleted replies (no text content)
          if (!reply[3]?.[1]) continue;

          comment.replies.push({
            id: reply[0],
            text: reply[3]?.[1],
            author: reply[4]?.[0],
            authorId: reply[4]?.[3],
            createdAt: reply[5],
            modifiedAt: reply[6],
          });
        }
      }

      comments.push(comment);
    }
  }

  return comments;
}

function getDocId() {
  const match = window.location.href.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

/**
 * Extract document outline from the navigation sidebar.
 * Includes tabs, sections hierarchy, and current reading position.
 */
function getDocumentOutline() {
  // Get tabs (Google Docs supports multiple tabs per document)
  const tabs = [];
  const chapterItems = document.querySelectorAll('.chapter-item');

  chapterItems.forEach((item) => {
    const label = item.querySelector('.chapter-label-content')?.innerText?.trim();
    const isSelected =
      item.querySelector('.chapter-item-label-and-buttons-container-selected') !== null;
    if (label) {
      tabs.push({ name: label, isSelected });
    }
  });

  const currentTab = tabs.find((t) => t.isSelected)?.name || null;

  // Get sections (headings) with their hierarchy
  // Level 0 = document title, 1 = H1, 2 = H2, etc.
  const sections = [];
  const levelItems = document.querySelectorAll('[class*="navigation-item-level-"]');

  levelItems.forEach((item) => {
    const levelMatch = item.className.match(/navigation-item-level-(\d+)/);
    const level = levelMatch ? parseInt(levelMatch[1]) : 0;
    const title = item.getAttribute('data-tooltip') || item.innerText?.trim();
    const parent = item.closest('.navigation-item');
    const isActive = parent?.classList.contains('location-indicator-highlight') || false;

    if (title) {
      sections.push({ title, level, isActive });
    }
  });

  const currentSection = sections.find((s) => s.isActive)?.title || null;

  return {
    tabs,
    currentTab,
    sections,
    currentSection,
  };
}
