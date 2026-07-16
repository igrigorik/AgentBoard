# `read_page` Tool v5.0.0

A WebMCP tool that reads the current rendered page for LLM context. It uses Mozilla Readability for article-like pages and falls back to the browser's rendered text for dashboards, authenticated applications, navigation pages, and other non-article layouts.

## Extraction strategy

The tool selects one of three modes:

1. `article`: Rendered paragraph-rich pages are cloned and parsed with Mozilla Readability, then converted to Markdown when the extracted text is fully represented in the live rendered page.
2. `rendered-text`: Other pages use `innerText` from one unambiguous semantic content region.
3. `metadata`: Pages without safely selectable rendered text still return their title, source, description when available, and an explicit status in `markdownContent`.

The paragraph heuristic only chooses whether to attempt Readability. It never prevents the rendered-text fallback.

### Rendered-text root selection

The fallback prefers standards-based landmarks without guessing from site-specific classes or IDs:

1. One visible modal dialog: `[role="dialog"][aria-modal="true"]`, `[role="alertdialog"][aria-modal="true"]`, or a native `dialog:modal`.
2. One visible `main` or `[role="main"]` region.
3. `document.body`.
4. `document.documentElement`.

Multiple visible main regions are ambiguous, so the tool uses `body.innerText` rather than silently discarding sibling content. Multiple or unreadable active dialogs instead return metadata context: broadening to `body` could expose obscured background content. An unambiguous active modal always takes precedence over article extraction because it represents the current foreground state.

### Rendered-text normalization

`innerText` already applies the browser's layout and visibility rules. Post-processing is intentionally limited to:

- normalizing line endings;
- replacing non-breaking spaces with ordinary spaces;
- removing null characters and invisible trailing horizontal whitespace;
- removing leading and trailing blank lines;
- enforcing the output length limit.

The fallback does not reconstruct headings, lists, tables, controls, or repeated lines. Tabs, internal blank lines, code indentation, Unicode, and document order are preserved.

## Usage

```javascript
async function readPage(args = {}) {
  const tools = await document.modelContext.getTools();
  const tool = tools.find(({ name }) => name === 'agentboard_read_page');
  if (!tool) throw new Error('agentboard_read_page is not registered');
  return JSON.parse(await document.modelContext.executeTool(tool, JSON.stringify(args)));
}

const result = await readPage({
  maxLength: 32000,
});
```

`maxLength` applies to the complete Markdown document, including its metadata header. It defaults to 32,000 characters and is constrained to 1,000–100,000 characters. Truncated output ends with `[Content truncated]`.

## Output

```javascript
{
  success: true,
  extractionMode: 'article' | 'rendered-text' | 'metadata',
  metadata: {
    title: 'Page title',
    url: 'https://example.com/page',
    author: 'Author name',
    siteName: 'Example',
    publishedTime: '2026-07-16T12:00:00Z',
    modifiedTime: null,
    language: 'en',
    direction: 'ltr',
    extractedAt: '2026-07-16T12:30:00Z',
  },
  markdownContent: '# Page title\n*Source: https://example.com/page*\n\n---\n\nPage content…',
  truncated: false,
  stats: {
    characterCount: 1234,
    wordCount: 220,
    estimatedReadTime: 2,
  },
}
```

The result has one canonical content representation. It does not duplicate the page as HTML and plain text.

## Migrating from v4

Version 5 intentionally changes the result contract:

- `extractionMode` replaces the article-specific `readable` flag.
- Non-article pages and extraction failures now return useful `success: true` context instead of `markdownContent: null`.
- `alternateFormats.html`, `alternateFormats.text`, and the Readability `excerpt` copy were removed to avoid sending duplicate content to the model.
- Rich Open Graph, Twitter Card, favicon, keyword, and duplicate description fields were replaced by compact source metadata; statistics now describe the canonical returned document.
- `stats.imageCount` and `stats.linkCount` were removed.
- Omitted `maxLength` now defaults to 32,000 characters instead of unlimited output; valid values are 1,000–100,000.
- The old failure-only `message`, `hint`, and `error` fields were removed.

## Failure behavior

Readability failure is not a tool failure. Clone, parse, conversion, visibility-validation, and document-size failures continue through the rendered-text path. Documents above 50,000 elements, 100,000 total nodes, or approximately two million serialized characters skip cloning to avoid unnecessary main-thread allocation. If rendered-text APIs are unavailable or the page has no safely selectable text, the metadata mode returns nonempty context instead of `null` content.

## Known boundaries

The rendered-text fallback represents the browser's rendered text, not a complete DOM or accessibility snapshot. It intentionally does not expose input values, checkbox state, image alt attributes, closed details content, generated CSS content, hidden virtualized rows, canvas pixels, cross-origin iframe documents, or shadow-root internals that `innerText` omits. Text hidden only through opacity, off-screen positioning, or ARIA can still appear because those mechanisms do not remove it from layout text.

These boundaries avoid a custom visibility engine, ARIA-name implementation, DOM serializer, debugger permission, or raw HTML fallback. If automation later requires control state or accessibility-tree inspection, that should be a separate explicit capability.

## Verification

`tests/webmcp-readability.test.ts` executes the production source in JSDOM for routing, result contracts, truncation, and failure recovery. `tests/browser/read-page.html` exercises browser-owned `innerText`, layout visibility, native modal, and compiled-registration behavior in real headless Chromium.

```bash
pnpm run test:browser
```

The browser command builds the extension first, runs without opening a window, and discovers Chrome or Chromium from common platform paths. Set `CHROME_BIN` when the executable lives elsewhere.

## Architecture and CSP

The tool inlines Mozilla Readability for CSP-safe injection through `chrome.scripting.executeScript({ files: [...] })`. It uses no `eval()` or `new Function()` at runtime.

**Readability source of truth:** `src/lib/webmcp/vendor/readability.js`

After updating the vendored library, copy it into `script.js` as documented in [`vendor/README.md`](../../vendor/README.md).

## License

Mozilla Readability is licensed under Apache License 2.0.
