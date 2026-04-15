'use webmcp-tool v1';

export const metadata = {
  name: 'email_context',
  namespace: 'gmail',
  version: '0.2.0',
  description:
    'Extract the currently open Gmail email thread with sender info, timestamps, and message bodies as markdown.',
  match: 'https://mail.google.com/*',
  inputSchema: {
    type: 'object',
    properties: {
      includeQuotedText: {
        type: 'boolean',
        description:
          'Include quoted reply text in message bodies. Default false — strips nested quotes for cleaner LLM context.',
        default: false,
      },
    },
    additionalProperties: false,
  },
};

// Trusted Types passthrough — Gmail enforces TT on all HTML sinks
const _safeHTML = (() => {
  if (typeof trustedTypes !== 'undefined') {
    try {
      const p = trustedTypes.createPolicy('agentboard-gmail', {
        createHTML: (s) => s,
      });
      return (html) => p.createHTML(html);
    } catch (e) { // eslint-disable-line no-unused-vars
    }
  }
  return (html) => html;
})();

// --- Parameter extraction ---

// Per-user key embedded in page scripts, required for internal endpoints.
function getIkValue() {
  try {
    if (typeof GLOBALS !== 'undefined' && GLOBALS[9]) return GLOBALS[9];
  } catch (e) { /* fall through */ } // eslint-disable-line no-unused-vars

  for (const s of document.querySelectorAll('script:not([src])')) {
    const m = s.textContent?.match(/\["ik","([0-9a-f]+)"\]/);
    if (m) return m[1];
    const m2 = s.textContent?.match(/ik\s*[:=]\s*["']([0-9a-f]{8,16})["']/);
    if (m2) return m2[1];
  }
  return null;
}

// Thread permanent ID from DOM: "thread-f:NUMERIC_ID"
function getThreadPermId() {
  return document.querySelector('[data-thread-perm-id]')?.getAttribute('data-thread-perm-id') || null;
}

function getAccountIndex() {
  return (window.location.pathname.match(/\/mail\/u\/(\d+)/) || [, '0'])[1];
}

function getSubject() {
  const h2 =
    document.querySelector('h2[data-thread-perm-id]') ||
    document.querySelector('h2.hP');
  if (h2) return h2.textContent.trim();
  return document.title.replace(/ - [^-]+ - Gmail$/, '').trim() || 'No subject';
}

// --- Printable view: fetch + parse ---

// Gmail's printable view returns clean HTML with all thread messages.
// Same endpoint Gmail's own "Print all" button uses.
async function fetchPrintableView(ik, threadPermId, acct) {
  const url = `/mail/u/${acct}?ik=${ik}&view=pt&search=all&permthid=${encodeURIComponent(threadPermId)}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) return null;
      return await resp.text();
    } catch (e) { // eslint-disable-line no-unused-vars
      if (attempt === 2) return null;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return null;
}

// Printable view structure per message:
//   <table class="message">
//     <tr><td>Name &lt;email&gt;</td><td>Date</td></tr>
//     <tr><td colspan=2>recipients</td></tr>
//     <tr><td colspan=2><table><tr><td><div style="overflow:hidden">BODY</div></td></tr></table></td></tr>
//   </table>
function parsePrintableView(html, includeQuotedText) {
  const doc = new DOMParser().parseFromString(_safeHTML(html), 'text/html');

  const subject =
    doc.querySelector('title')?.textContent?.replace(/ - Gmail$/, '')
      .replace(/^.*? - /, '').trim() || 'No subject';

  const msgTables = doc.querySelectorAll('table.message');
  const messages = [];

  for (const table of msgTables) {
    const rows = table.querySelectorAll(':scope > tbody > tr, :scope > tr');
    const headerCells = rows[0]?.querySelectorAll('td') || [];

    const senderRaw = headerCells[0]?.textContent?.trim() || '';
    const senderMatch = senderRaw.match(/^(.+?)\s*<([^>]+)>$/);
    const sender = senderMatch
      ? { name: senderMatch[1].trim(), email: senderMatch[2].trim() }
      : { name: senderRaw, email: senderRaw };

    const date = headerCells[1]?.textContent?.trim() || '';

    const bodyEl =
      table.querySelector('div[style*="overflow"]') ||
      table.querySelector('td[colspan] table td div');

    const body = bodyEl ? htmlToMarkdown(bodyEl, includeQuotedText) : '';

    messages.push({ sender, date, body });
  }

  return { subject, messages };
}

// --- HTML → Markdown (email-optimized, self-contained) ---

function htmlToMarkdown(element, includeQuotedText) {
  const clone = element.cloneNode(true);

  if (!includeQuotedText) {
    clone
      .querySelectorAll('.gmail_quote, blockquote[class*="gmail"]')
      .forEach((q) => q.remove());
    clone.querySelectorAll('font[color="#888888"]').forEach((el) => {
      if (el.textContent?.includes('Quoted text')) el.remove();
    });
  }

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    if (['script', 'style', 'noscript'].includes(tag)) return '';

    const children = Array.from(node.childNodes).map(walk).join('');

    switch (tag) {
      case 'h1':
        return `\n\n# ${children.trim()}\n`;
      case 'h2':
        return `\n\n## ${children.trim()}\n`;
      case 'h3':
        return `\n\n### ${children.trim()}\n`;
      case 'p':
        return children.trim() ? `\n\n${children.trim()}` : '';
      case 'br':
        return '\n';
      case 'hr':
        return '\n\n---\n';
      case 'strong':
      case 'b':
        return children.trim() ? `**${children.trim()}**` : '';
      case 'em':
      case 'i':
        return children.trim() ? `*${children.trim()}*` : '';
      case 'a': {
        const href = node.getAttribute('href');
        // Unwrap Gmail's safe redirect wrapper
        const realHref = href?.includes('saferedirecturl')
          ? new URL(href).searchParams.get('q') || href
          : href;
        if (realHref && !realHref.startsWith('javascript:')) {
          return `[${children.trim()}](${realHref})`;
        }
        return children;
      }
      case 'ul':
        return `\n${Array.from(node.children)
          .filter((c) => c.tagName?.toLowerCase() === 'li')
          .map((li) => `- ${walk(li).trim()}`)
          .join('\n')}\n`;
      case 'ol':
        return `\n${Array.from(node.children)
          .filter((c) => c.tagName?.toLowerCase() === 'li')
          .map((li, i) => `${i + 1}. ${walk(li).trim()}`)
          .join('\n')}\n`;
      case 'blockquote':
        if (!children.trim()) return '';
        return (
          '\n' +
          children
            .trim()
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n') +
          '\n'
        );
      case 'code':
        return children.trim() ? `\`${children.trim()}\`` : '';
      case 'pre':
        return `\n\`\`\`\n${children.trim()}\n\`\`\`\n`;
      case 'img':
        return node.getAttribute('alt') ? `[image: ${node.getAttribute('alt')}]` : '';
      case 'div':
        return children.trim() ? `\n${children.trim()}` : '';
      default:
        return children;
    }
  }

  return walk(clone)
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/^\n+|\n+$/g, '')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

// --- Main ---

export async function execute(args = {}) {
  const { includeQuotedText = false } = args;

  const threadPermId = getThreadPermId();
  if (!threadPermId) {
    throw new Error(
      'No email thread open. Navigate to a specific email in Gmail first.'
    );
  }

  const ik = getIkValue();
  if (!ik) {
    throw new Error(
      'Could not extract Gmail session key (ik). The page may not be fully loaded.'
    );
  }

  const acct = getAccountIndex();
  const html = await fetchPrintableView(ik, threadPermId, acct);

  if (!html) {
    throw new Error(
      'Failed to fetch thread data from Gmail. The session may have expired — try reloading.'
    );
  }

  const { subject, messages } = parsePrintableView(html, includeQuotedText);

  if (messages.length === 0) {
    throw new Error(
      'Printable view returned no messages. Gmail\'s response format may have changed.'
    );
  }

  const participants = [
    ...new Set(messages.map((m) => m.sender.email).filter(Boolean)),
  ];

  const markdownParts = [
    `# ${subject}`,
    `*Thread: ${messages.length} messages, ${participants.length} participants*`,
    '',
  ];

  for (const msg of messages) {
    const senderLabel = msg.sender.name || msg.sender.email;
    markdownParts.push(`**${senderLabel}** — ${msg.date}`, '');
    if (msg.body) {
      markdownParts.push(msg.body);
    }
    markdownParts.push('', '---', '');
  }

  const markdownContent = markdownParts.join('\n').trim();

  return {
    content: [{ type: 'text', text: markdownContent }],
    metadata: {
      threadPermId,
      subject,
      messageCount: messages.length,
      participantCount: participants.length,
    },
  };
}
