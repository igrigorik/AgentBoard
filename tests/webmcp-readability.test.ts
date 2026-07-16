import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseUserScript } from '../src/lib/webmcp/script-parser';
// The tool is authored as self-contained JavaScript because Vite injects the compiled file in MAIN world.
// @ts-expect-error TypeScript intentionally does not compile built-in WebMCP tool sources.
import { execute } from '../src/lib/webmcp/tools/read_page/script.js';
import readPageScript from '../src/lib/webmcp/tools/read_page/script.js?raw';

type ReadPageResult = {
  success: boolean;
  extractionMode: 'article' | 'rendered-text' | 'metadata';
  metadata: Record<string, unknown>;
  markdownContent: string;
  truncated: boolean;
  stats: {
    characterCount: number;
    wordCount: number;
    estimatedReadTime: number;
  };
};

function setInnerText(element: Element, text: string): void {
  Object.defineProperty(element, 'innerText', {
    configurable: true,
    value: text,
  });
}

function setRendered(element: Element): void {
  Object.defineProperty(element, 'getClientRects', {
    configurable: true,
    value: () => ({ length: 1 }),
  });
}

async function readPage(args: Record<string, unknown> = {}): Promise<ReadPageResult> {
  return execute(args) as Promise<ReadPageResult>;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe('WebMCP read_page tool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.head.innerHTML = '<title>Test Page</title>';
    document.body.innerHTML = '';
    setInnerText(document.body, '');
    setInnerText(document.documentElement, '');
  });

  it('publishes the rendered-page contract', () => {
    const parsed = parseUserScript(readPageScript, false);

    expect(parsed.metadata).toMatchObject({
      name: 'read_page',
      namespace: 'agentboard',
      version: '5.0.0',
      match: ['<all_urls>'],
      inputSchema: {
        properties: {
          maxLength: {
            minimum: 1000,
            maximum: 100000,
            default: 32000,
          },
        },
      },
    });
    expect(parsed.metadata.description).toContain('visible page text');
  });

  it('preserves the real Readability article path without duplicate formats', async () => {
    document.head.innerHTML =
      '<title>Test Article</title><meta name="author" content="Ada Lovelace">';
    const prose = 'Substantive article prose with enough context for extraction. '.repeat(20);
    document.body.innerHTML = `
      <main>
        <h1>Test Article</h1>
        <p>${prose}</p>
        <p><img src="https://example.test/image.png" alt="ARTICLE_IMAGE_ALT"></p>
      </main>
    `;
    const main = document.querySelector('main')!;
    const paragraph = document.querySelector('p')!;
    setRendered(main);
    setRendered(paragraph);
    setInnerText(paragraph, prose);
    setInnerText(main, `Test Article\n${prose}`);
    setInnerText(document.body, `Test Article\n${prose}`);

    const result = await readPage({ maxLength: 10000 });

    expect(result.success).toBe(true);
    expect(result.extractionMode).toBe('article');
    expect(result.markdownContent).toContain('# Test Article');
    expect(result.markdownContent).toContain('Substantive article prose');
    expect(result.markdownContent).not.toContain('ARTICLE_IMAGE_ALT');
    expect(result.metadata.author).toBe('Ada Lovelace');
    expect(result.metadata).not.toHaveProperty('excerpt');
    expect(result).not.toHaveProperty('alternateFormats');
    expect(result).not.toHaveProperty('readable');
  });

  it('reads a paragraph-free dashboard from its unique main landmark', async () => {
    document.head.innerHTML = '<title>Search Console</title>';
    document.body.innerHTML = `
      <nav>Overview Insights Performance</nav>
      <main role="main"><h1>Excluded by noindex tag</h1><table><tr><th>URL</th><th>Last crawled</th></tr></table></main>
      <footer>Privacy Terms</footer>
    `;
    const main = document.querySelector('main')!;
    setRendered(main);
    setInnerText(
      main,
      'Excluded by noindex tag\nAffected pages\n12\nURL\tLast crawled\nhttps://example.com/a\tJun 26, 2026'
    );
    setInnerText(
      document.body,
      'Overview Insights Performance\nExcluded by noindex tag\nPrivacy Terms'
    );

    const result = await readPage();

    expect(result.extractionMode).toBe('rendered-text');
    expect(result.markdownContent).toContain('Affected pages\n12');
    expect(result.markdownContent).toContain('URL\tLast crawled');
    expect(result.markdownContent).not.toContain('Overview Insights Performance');
    expect(result.markdownContent).not.toContain('Privacy Terms');
  });

  it('does not let CSS-hidden paragraphs trigger or contaminate article extraction', async () => {
    const visible = 'Visible article prose with enough context for extraction. '.repeat(20);
    const hidden = 'CSS_HIDDEN_SECRET '.repeat(40);
    document.head.innerHTML =
      '<title>Visibility check</title><style>.concealed { display: none }</style>';
    document.body.innerHTML = `
      <main>
        <p>${visible}</p>
        <p class="concealed">${hidden}</p>
      </main>
    `;
    const main = document.querySelector('main')!;
    const visibleParagraph = document.querySelector('p:not(.concealed)')!;
    setRendered(main);
    setRendered(visibleParagraph);
    setInnerText(visibleParagraph, visible);
    setInnerText(main, visible);
    setInnerText(document.body, visible);

    const result = await readPage({ maxLength: 10000 });

    expect(result.markdownContent).toContain('Visible article prose');
    expect(result.markdownContent).not.toContain('CSS_HIDDEN_SECRET');
  });

  it('does not publish a CSS-hidden Readability byline', async () => {
    const prose = 'Visible article prose with enough context for extraction. '.repeat(20);
    document.head.innerHTML =
      '<title>Visible article</title><style>.byline { display: none }</style>';
    document.body.innerHTML = `
      <main>
        <h1>Visible article</h1>
        <div class="byline">HIDDEN_BYLINE_SECRET</div>
        <p>${prose}</p>
      </main>
    `;
    const main = document.querySelector('main')!;
    const paragraph = document.querySelector('p')!;
    setRendered(main);
    setRendered(paragraph);
    setInnerText(paragraph, prose);
    setInnerText(main, `Visible article\n${prose}`);
    setInnerText(document.body, `Visible article\n${prose}`);

    const result = await readPage({ maxLength: 10000 });

    expect(result.extractionMode).toBe('article');
    expect(result.metadata.author).toBeNull();
    expect(result.markdownContent).not.toContain('HIDDEN_BYLINE_SECRET');
  });

  it('prefers a unique active dialog over background page content', async () => {
    document.body.innerHTML = `
      <main>Account settings</main>
      <div role="dialog" aria-modal="true">Delete account?</div>
    `;
    const main = document.querySelector('main')!;
    const dialog = document.querySelector('[role="dialog"]')!;
    setRendered(main);
    setRendered(dialog);
    setInnerText(main, 'Account settings');
    setInnerText(dialog, 'Delete account?\nCancelDelete');
    setInnerText(document.body, 'Account settings\nDelete account?\nCancelDelete');

    const result = await readPage();

    expect(result.markdownContent).toContain('Delete account?');
    expect(result.markdownContent).not.toContain('Account settings');
  });

  it('keeps an active modal foreground ahead of an article-like background', async () => {
    const prose = 'Long background article prose that must remain obscured. '.repeat(20);
    document.body.innerHTML = `
      <main><p>${prose}</p></main>
      <div role="alertdialog" aria-modal="true">Session expired</div>
    `;
    const main = document.querySelector('main')!;
    const paragraph = document.querySelector('p')!;
    const dialog = document.querySelector('[role="alertdialog"]')!;
    setRendered(main);
    setRendered(paragraph);
    setRendered(dialog);
    setInnerText(paragraph, prose);
    setInnerText(main, prose);
    setInnerText(dialog, 'Session expired\nSign in again');
    setInnerText(document.body, `${prose}\nSession expired\nSign in again`);

    const result = await readPage();

    expect(result.extractionMode).toBe('rendered-text');
    expect(result.markdownContent).toContain('Session expired');
    expect(result.markdownContent).not.toContain('Long background article prose');
  });

  it('does not expose an article behind a textless active modal', async () => {
    const prose = 'Background article content hidden by a canvas modal. '.repeat(20);
    document.body.innerHTML = `
      <main><p>${prose}</p></main>
      <div role="dialog" aria-modal="true"><canvas></canvas></div>
    `;
    const main = document.querySelector('main')!;
    const paragraph = document.querySelector('p')!;
    const dialog = document.querySelector('[role="dialog"]')!;
    setRendered(main);
    setRendered(paragraph);
    setRendered(dialog);
    setInnerText(paragraph, prose);
    setInnerText(main, prose);
    setInnerText(dialog, '');
    setInnerText(document.body, prose);

    const result = await readPage();

    expect(result.extractionMode).toBe('metadata');
    expect(result.markdownContent).not.toContain('Background article content');
  });

  it('ignores a modeless native dialog when a unique main region exists', async () => {
    document.body.innerHTML = '<main>Main report</main><dialog open>Modeless preferences</dialog>';
    const main = document.querySelector('main')!;
    const dialog = document.querySelector('dialog')!;
    setRendered(main);
    setRendered(dialog);
    setInnerText(main, 'Main report');
    setInnerText(dialog, 'Modeless preferences');
    setInnerText(document.body, 'Main report\nModeless preferences');

    const result = await readPage();

    expect(result.markdownContent).toContain('Main report');
    expect(result.markdownContent).not.toContain('Modeless preferences');
  });

  it('uses body rather than discarding content when semantic landmarks are ambiguous', async () => {
    document.body.innerHTML = '<main>Small utility</main><div role="main">Primary report</div>';
    const mains = Array.from(document.querySelectorAll('main, [role="main"]'));
    mains.forEach(setRendered);
    setInnerText(mains[0], 'Small utility');
    setInnerText(mains[1], 'Primary report');
    setInnerText(document.body, 'Small utility\nPrimary report');

    const result = await readPage();

    expect(result.markdownContent).toContain('Small utility\nPrimary report');
  });

  it('fails closed when multiple modal dialogs make foreground selection ambiguous', async () => {
    document.body.innerHTML = `
      <main>Background report</main>
      <div role="dialog" aria-modal="true">First dialog</div>
      <div role="alertdialog" aria-modal="true">Second dialog</div>
    `;
    for (const element of document.querySelectorAll(
      'main, [role="dialog"], [role="alertdialog"]'
    )) {
      setRendered(element);
      setInnerText(element, element.textContent || '');
    }
    setInnerText(document.body, 'Background report\nFirst dialog\nSecond dialog');

    const result = await readPage();

    expect(result.extractionMode).toBe('metadata');
    expect(result.markdownContent).not.toContain('Background report');
    expect(result.markdownContent).not.toContain('First dialog');
    expect(result.markdownContent).not.toContain('Second dialog');
  });

  it('skips Readability cloning when DOM source exceeds its resource budget', async () => {
    const prose = 'Article-looking visible text. '.repeat(30);
    document.body.innerHTML = `<main><p>${prose}</p><script></script></main>`;
    document.querySelector('script')!.textContent = 'x'.repeat(2_000_001);
    const main = document.querySelector('main')!;
    const paragraph = document.querySelector('p')!;
    setRendered(main);
    setRendered(paragraph);
    setInnerText(paragraph, prose);
    setInnerText(main, prose);
    setInnerText(document.body, prose);

    let cloneAttempted = false;
    const documentElement = document.documentElement;
    const originalOuterHTML = Object.getOwnPropertyDescriptor(documentElement, 'outerHTML');
    Object.defineProperty(documentElement, 'outerHTML', {
      configurable: true,
      get: () => {
        cloneAttempted = true;
        throw new Error('oversized DOM should not be serialized');
      },
    });

    try {
      const result = await readPage();
      expect(result.extractionMode).toBe('rendered-text');
      expect(result.markdownContent).toContain('Article-looking visible text');
      expect(cloneAttempted).toBe(false);
    } finally {
      if (originalOuterHTML) {
        Object.defineProperty(documentElement, 'outerHTML', originalOuterHTML);
      } else {
        Reflect.deleteProperty(documentElement, 'outerHTML');
      }
    }
  });

  it('includes template contents in the Readability source budget', async () => {
    const prose = 'Article-looking visible text. '.repeat(30);
    document.body.innerHTML = `<main><p>${prose}</p><template></template></main>`;
    document.querySelector('template')!.innerHTML = 'x'.repeat(2_000_001);
    const main = document.querySelector('main')!;
    const paragraph = document.querySelector('p')!;
    setRendered(main);
    setRendered(paragraph);
    setInnerText(paragraph, prose);
    setInnerText(main, prose);
    setInnerText(document.body, prose);

    let cloneAttempted = false;
    const documentElement = document.documentElement;
    const originalOuterHTML = Object.getOwnPropertyDescriptor(documentElement, 'outerHTML');
    Object.defineProperty(documentElement, 'outerHTML', {
      configurable: true,
      get: () => {
        cloneAttempted = true;
        throw new Error('oversized template should not be serialized');
      },
    });

    try {
      const result = await readPage();
      expect(result.extractionMode).toBe('rendered-text');
      expect(result.markdownContent).toContain('Article-looking visible text');
      expect(cloneAttempted).toBe(false);
    } finally {
      if (originalOuterHTML) {
        Object.defineProperty(documentElement, 'outerHTML', originalOuterHTML);
      } else {
        Reflect.deleteProperty(documentElement, 'outerHTML');
      }
    }
  });

  it('counts non-element nodes before cloning for Readability', async () => {
    const prose = 'Article-looking visible text. '.repeat(30);
    document.body.innerHTML = `<main><p>${prose}</p></main>`;
    const main = document.querySelector('main')!;
    const paragraph = document.querySelector('p')!;
    setRendered(main);
    setRendered(paragraph);
    setInnerText(paragraph, prose);
    setInnerText(main, prose);
    setInnerText(document.body, prose);

    const comment = document.createComment('');
    let remainingNodes = 100_001;
    vi.spyOn(document, 'createTreeWalker').mockReturnValue({
      currentNode: document.documentElement,
      nextNode: () => (remainingNodes-- > 0 ? comment : null),
    } as unknown as TreeWalker);

    let cloneAttempted = false;
    const documentElement = document.documentElement;
    const originalOuterHTML = Object.getOwnPropertyDescriptor(documentElement, 'outerHTML');
    Object.defineProperty(documentElement, 'outerHTML', {
      configurable: true,
      get: () => {
        cloneAttempted = true;
        throw new Error('excessive node count should not be serialized');
      },
    });

    try {
      const result = await readPage();
      expect(result.extractionMode).toBe('rendered-text');
      expect(cloneAttempted).toBe(false);
    } finally {
      if (originalOuterHTML) {
        Object.defineProperty(documentElement, 'outerHTML', originalOuterHTML);
      } else {
        Reflect.deleteProperty(documentElement, 'outerHTML');
      }
    }
  });

  it('rejects an oversized serialized document before parsing it', async () => {
    const prose = 'Article-looking visible text. '.repeat(30);
    document.body.innerHTML = `<main><p>${prose}</p></main>`;
    const main = document.querySelector('main')!;
    const paragraph = document.querySelector('p')!;
    setRendered(main);
    setRendered(paragraph);
    setInnerText(paragraph, prose);
    setInnerText(main, prose);
    setInnerText(document.body, prose);

    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const documentElement = document.documentElement;
    const originalOuterHTML = Object.getOwnPropertyDescriptor(documentElement, 'outerHTML');
    Object.defineProperty(documentElement, 'outerHTML', {
      configurable: true,
      get: () => 'x'.repeat(2_000_001),
    });

    try {
      const result = await readPage();
      expect(result.extractionMode).toBe('rendered-text');
      expect(parse).not.toHaveBeenCalled();
    } finally {
      if (originalOuterHTML) {
        Object.defineProperty(documentElement, 'outerHTML', originalOuterHTML);
      } else {
        Reflect.deleteProperty(documentElement, 'outerHTML');
      }
    }
  });

  it('falls back to rendered text when article extraction throws', async () => {
    const prose = 'Article-looking text that should enter Readability. '.repeat(20);
    document.body.innerHTML = `
      <main><p>${prose}</p></main>
    `;
    const main = document.querySelector('main')!;
    const paragraph = document.querySelector('p')!;
    setRendered(main);
    setRendered(paragraph);
    setInnerText(paragraph, prose);
    setInnerText(main, 'Rendered recovery content');
    setInnerText(document.body, 'Rendered recovery content');
    const documentElement = document.documentElement;
    const originalOuterHTML = Object.getOwnPropertyDescriptor(documentElement, 'outerHTML');
    Object.defineProperty(documentElement, 'outerHTML', {
      configurable: true,
      get: () => {
        throw new Error('clone failed');
      },
    });

    try {
      const result = await readPage();
      expect(result.extractionMode).toBe('rendered-text');
      expect(result.markdownContent).toContain('Rendered recovery content');
    } finally {
      if (originalOuterHTML) {
        Object.defineProperty(documentElement, 'outerHTML', originalOuterHTML);
      } else {
        Reflect.deleteProperty(documentElement, 'outerHTML');
      }
    }
  });

  it('recovers through body when a semantic root innerText getter throws', async () => {
    document.body.innerHTML = '<main>Body can recover this content</main>';
    const main = document.querySelector('main')!;
    setRendered(main);
    Object.defineProperty(main, 'innerText', {
      configurable: true,
      get: () => {
        throw new Error('hostile getter');
      },
    });
    setInnerText(document.body, 'Body can recover this content');

    const result = await readPage();

    expect(result.extractionMode).toBe('rendered-text');
    expect(result.markdownContent).toContain('Body can recover this content');
  });

  it('fails closed when a higher-priority dialog cannot be read', async () => {
    document.body.innerHTML = `
      <main>Background context</main>
      <div role="dialog" aria-modal="true">Dialog context</div>
    `;
    const main = document.querySelector('main')!;
    const dialog = document.querySelector('[role="dialog"]')!;
    setRendered(main);
    setRendered(dialog);
    setInnerText(main, 'Background context');
    Object.defineProperty(dialog, 'innerText', {
      configurable: true,
      get: () => {
        throw new Error('dialog getter failed');
      },
    });
    setInnerText(document.body, 'Background context\nDialog context');

    const result = await readPage();

    expect(result.extractionMode).toBe('metadata');
    expect(result.markdownContent).not.toContain('Background context');
    expect(result.markdownContent).not.toContain('Dialog context');
  });

  it('returns metadata when broad document root getters throw', async () => {
    document.head.innerHTML = '<title>Hostile roots</title>';
    const bodyDescriptor = Object.getOwnPropertyDescriptor(document, 'body');
    const documentElementDescriptor = Object.getOwnPropertyDescriptor(document, 'documentElement');
    Object.defineProperties(document, {
      body: {
        configurable: true,
        get: () => {
          throw new Error('hostile body getter');
        },
      },
      documentElement: {
        configurable: true,
        get: () => {
          throw new Error('hostile documentElement getter');
        },
      },
    });

    try {
      const result = await readPage();
      expect(result.extractionMode).toBe('metadata');
      expect(result.markdownContent).toContain('# Hostile roots');
    } finally {
      if (bodyDescriptor) Object.defineProperty(document, 'body', bodyDescriptor);
      else Reflect.deleteProperty(document, 'body');
      if (documentElementDescriptor) {
        Object.defineProperty(document, 'documentElement', documentElementDescriptor);
      } else {
        Reflect.deleteProperty(document, 'documentElement');
      }
    }
  });

  it('returns metadata context when no rendered text is available', async () => {
    document.head.innerHTML = `
      <title>Canvas editor</title>
      <meta name="description" content="Collaborative diagram editor">
    `;
    document.body.innerHTML = '<canvas></canvas>';

    const result = await readPage();

    expect(result.success).toBe(true);
    expect(result.extractionMode).toBe('metadata');
    expect(result.markdownContent).toContain('# Canvas editor');
    expect(result.markdownContent).toContain('Collaborative diagram editor');
  });

  it('uses the first nonblank description and title metadata', async () => {
    document.head.innerHTML = `
      <title>   </title>
      <meta name="description" content="   ">
      <meta property="og:title" content="Open Graph title">
      <meta property="og:description" content="Open Graph summary">
    `;

    const result = await readPage();

    expect(result.extractionMode).toBe('metadata');
    expect(result.markdownContent).toContain('# Open Graph title');
    expect(result.markdownContent).toContain('Open Graph summary');
  });

  it('always returns nonempty context when both rendered text and descriptions are absent', async () => {
    document.head.innerHTML = '<title></title>';

    const result = await readPage();

    expect(result.extractionMode).toBe('metadata');
    expect(result.metadata.title).toBe('Untitled page');
    expect(result.markdownContent).toContain('# Untitled page');
    expect(result.markdownContent).toContain('No rendered text content is available');
  });

  it('only normalizes invisible whitespace and preserves code, tabs, and repeated lines', async () => {
    document.body.innerHTML = '<main></main>';
    const main = document.querySelector('main')!;
    setRendered(main);
    setInnerText(
      main,
      '\r\nfunction demo() {\r\n\treturn 1;  \r\n}\r\n\r\n\r\nRepeated\r\nRepeated\r\n1\u00a0234\u0000\r\n'
    );

    const result = await readPage({ maxLength: 10000 });

    expect(result.markdownContent).toContain('function demo() {\n\treturn 1;\n}');
    expect(result.markdownContent).toContain('}\n\n\nRepeated');
    expect(result.markdownContent.match(/Repeated/g)).toHaveLength(2);
    expect(result.markdownContent).toContain('1 234');
    expect(result.markdownContent).not.toContain('\u0000');
  });

  it('bounds the complete document and reports truncation accurately', async () => {
    document.body.innerHTML = '<main></main>';
    const main = document.querySelector('main')!;
    setRendered(main);
    setInnerText(main, 'Useful dashboard row with data\n'.repeat(200));

    const result = await readPage({ maxLength: 1000 });

    expect(result.truncated).toBe(true);
    expect(result.markdownContent.length).toBeLessThanOrEqual(1000);
    expect(result.markdownContent).toContain('Useful dashboard row');
    expect(result.markdownContent.endsWith('[Content truncated]')).toBe(true);
    expect(result.stats.characterCount).toBe(result.markdownContent.length);
  });

  it('keeps structured metadata compact so it cannot bury canonical content', async () => {
    document.head.innerHTML = `
      <title>Metadata budget</title>
      <meta name="description" content="${'metadata '.repeat(30000)}">
      <meta name="keywords" content="${'keywords '.repeat(30000)}">
    `;
    document.body.innerHTML = '<main></main>';
    const main = document.querySelector('main')!;
    setRendered(main);
    setInnerText(main, 'IMPORTANT_BODY_CONTEXT');

    const result = await readPage({ maxLength: 1000 });
    const serialized = JSON.stringify(result);

    expect(result.markdownContent).toContain('IMPORTANT_BODY_CONTEXT');
    expect(result.metadata).not.toHaveProperty('description');
    expect(result.metadata).not.toHaveProperty('keywords');
    expect(serialized.length).toBeLessThan(5000);
  });

  it('keeps truncated inline metadata on valid Unicode boundaries', async () => {
    const originalLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const urlPrefixLength = 998 - `${window.location.origin}/`.length;
    window.history.replaceState({}, '', `/${'u'.repeat(urlPrefixLength)}😀tail`);
    document.head.innerHTML = `
      <title>${'t'.repeat(198)}😀tail</title>
      <meta name="author" content="${'a'.repeat(198)}😀tail">
      <meta name="description" content="${'d'.repeat(1998)}😀tail">
    `;

    try {
      const result = await readPage({ maxLength: 10000 });

      expect(hasLoneSurrogate(String(result.metadata.title))).toBe(false);
      expect(hasLoneSurrogate(String(result.metadata.author))).toBe(false);
      expect(hasLoneSurrogate(String(result.metadata.url))).toBe(false);
      expect(hasLoneSurrogate(result.markdownContent)).toBe(false);
    } finally {
      window.history.replaceState({}, '', originalLocation);
    }
  });

  it('reserves useful body context when title and source metadata are long', async () => {
    document.head.innerHTML = `<title>${'Long title '.repeat(150)}</title>`;
    document.body.innerHTML = '<main></main>';
    const main = document.querySelector('main')!;
    setRendered(main);
    setInnerText(main, 'IMPORTANT_BODY_CONTEXT');

    const result = await readPage({ maxLength: 1000 });

    expect(result.markdownContent.length).toBeLessThanOrEqual(1000);
    expect(result.markdownContent).toContain('IMPORTANT_BODY_CONTEXT');
  });

  it('does not split a Unicode surrogate pair at a hard truncation boundary', async () => {
    document.body.innerHTML = '<main></main>';
    const main = document.querySelector('main')!;
    setRendered(main);
    const marker = '\n\n[Content truncated]';
    const header = `# Test Page\n*Source: ${window.location.href}*\n\n---\n\n`;
    const budget = 1000 - marker.length;
    setInnerText(main, `${'a'.repeat(budget - header.length - 1)}😀${'tail'.repeat(20)}`);

    const result = await readPage({ maxLength: 1000 });
    const beforeMarker = result.markdownContent.slice(0, -marker.length);
    const lastCodeUnit = beforeMarker.charCodeAt(beforeMarker.length - 1);

    expect(result.truncated).toBe(true);
    expect(lastCodeUnit < 0xd800 || lastCodeUnit > 0xdbff).toBe(true);
  });

  it('does not split a surrogate pair while bounding browser-rendered text', async () => {
    document.body.innerHTML = '<main></main>';
    const main = document.querySelector('main')!;
    setRendered(main);
    setInnerText(main, `${'a'.repeat(999)}😀tail`);

    const result = await readPage({ maxLength: 1000 });

    expect(hasLoneSurrogate(result.markdownContent)).toBe(false);
  });

  it('applies the published default bound when maxLength is omitted', async () => {
    document.body.innerHTML = '<main></main>';
    const main = document.querySelector('main')!;
    setRendered(main);
    setInnerText(main, 'x'.repeat(40000));

    const result = await readPage();

    expect(result.markdownContent.length).toBeLessThanOrEqual(32000);
    expect(result.truncated).toBe(true);
  });
});
