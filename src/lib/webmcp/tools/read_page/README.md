# `read_page` Tool v7.2.0

A single extension-owned AgentBoard capability that reads the current HTML page or PDF for LLM context. A tab-bound router inspects the browser-owned top document before invoking a private ISOLATED-world HTML host or AgentBoard's bounded local PDF.js worker. The model never chooses a MIME-specific tool, and the page never owns or observes AgentBoard's system reader.

## Extraction strategy

The tool selects one of four modes:

1. `article`: Rendered paragraph-rich HTML pages are cloned and parsed with Mozilla Readability, then converted to Markdown when the extracted text is fully represented in the live rendered page.
2. `rendered-text`: Other HTML pages use `innerText` from one unambiguous semantic content region.
3. `metadata`: HTML pages without safely selectable rendered text still return their title, source, description when available, and an explicit status in `markdownContent`.
4. `pdf`: The exact current PDF is acquired beside its document route, transferred directly to a dedicated local worker, and extracted sequentially with page boundaries, conservative geometry-based line/column ordering, and one reduced-resolution full-page JPEG per admitted page by default. Network PDFs are reacquired with the page session; `file://` PDFs are read only inside the claimed extension host.

The paragraph heuristic only chooses whether to attempt Readability. It never prevents the rendered-text fallback. The PDF branch does not run Readability against Chrome's viewer shell.

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

AgentBoard exposes `agentboard_read_page` directly to the configured model as a system built-in. The model may supply `maxLength`, `startPage`, `maxPages`, and `includePageImages`; MIME selection is internal. HTML extraction does not register a tool on `document.modelContext` or depend on the page's WebMCP bridge.

`maxLength` applies to the complete Markdown document, including its metadata header. It defaults to 32,000 characters and is constrained to 1,000–100,000 characters. Truncated output ends with `[Content truncated]`.

`startPage` and `maxPages` apply only to PDFs and are ignored for HTML pages. Pages are one-indexed. `maxPages` defaults to 25 and has a maximum of 50; successful PDF results return `nextPage` when more pages remain or another resource bound stops extraction. Local `file://` PDFs require Chrome’s “Allow access to file URLs” toggle for AgentBoard and a reload after enabling it.

`includePageImages` defaults to `true` and delivers mode-appropriate visuals under one shared image budget (1,024 px longest edge, one megapixel, JPEG): PDFs render full pages, and HTML pages capture the currently visible browser viewport. Models are instructed to set it to `false` only when the user explicitly requests text-only extraction or when retrying a prior image failure. Every image is fenced to the exact current document, and a failed image degrades the read rather than failing it: the affected page or capture is omitted, and the reason is reported in `warnings` — `PAGE_IMAGE_FAILED`/`PAGE_IMAGE_LIMIT_REACHED` with `nextPage` for PDFs, `VIEWPORT_UNAVAILABLE:<reason>` for HTML.

HTML capture uses `chrome.tabs.captureVisibleTab`, which photographs a window's active tab, so the bound tab must be that active tab — verified before and after the capture, with any ambiguity discarding the image. Successful HTML results also report `viewport` context from the private host — `scrollPercent` plus the first and last visible text snippets — so the model can locate the viewport within `markdownContent`. When extraction fails on a still-current route but the capture succeeded, the tool returns a `viewport-only` success whose `warnings` carry `HTML_EXTRACTION_FAILED` or `HTML_EXTRACTION_TIMEOUT`, giving the model visual context exactly when text extraction is blind.

## Output

```javascript
{
  success: true,
  extractionMode: 'article' | 'rendered-text' | 'metadata' | 'pdf',
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
  warnings: [], // PDF results only
  pdf: { // PDF results only
    pageCount: 19,
    startPage: 1,
    endPage: 5,
    nextPage: 6,
    layoutMode: 'layout',
    pageImages: [
      {
        imageIndex: 1,
        pageNumber: 1,
        width: 791,
        height: 1024,
        mediaType: 'image/jpeg',
        detail: 'low',
      },
    ],
  },
  stats: {
    characterCount: 1234,
    wordCount: 220,
    estimatedReadTime: 2,
    extractedPageCount: 5, // PDF results only
  },
}
```

The public result has one canonical text representation plus bounded byte-free image descriptors. PDF pages use geometry-backed reading order, conservative Markdown headings inferred from isolated font-size evidence or numbered-section syntax, normalized bullet markers, and a separate labeled block for sparse rotated or vertical text whose position cannot be reconstructed confidently. It does not contain HTML, duplicate plain text, raw PDF bytes, or encoded page images. A local PDF result does not duplicate the filesystem path in `metadata.url`; like every attached tab, its URL and title can still appear in the model’s ordinary page context. PDF acquisition, authentication, parser, permission, size, and navigation failures return `success: false` with a fixed typed error code; sensitive content and parser diagnostics are not included.

For media-capable connection APIs, AI SDK model-output conversion privately attaches JPEGs after one text part containing the canonical manifest: `Image K = PDF page N` for PDF renders, or `Image 1 = the user's current browser viewport` with its scroll position for HTML captures. The corresponding PDF Markdown section is labeled `## PDF page N — Image K`. Encoded bytes are held only in an ephemeral identity side channel (`model-output.ts`) and never enter public tool JSON, sidebar history, logs, or storage. OpenAI Chat Completions receives a text-only downgrade because that adapter cannot represent media in tool results.

## Changes in v7.2

Version 7.2 extends default-on visuals from PDFs to HTML pages:

- `includePageImages` now also controls one viewport screenshot for HTML reads, capturing the graphics, layout, and on-screen state that text extraction cannot represent.
- Successful HTML results add `viewport` scroll context with first/last visible text snippets, and byte-free `images` descriptors when a capture was delivered.
- Capture is identity-fenced: the bound tab must be its window's active tab before and after the capture, and the exact document route must remain current; otherwise the read degrades to `VIEWPORT_UNAVAILABLE:<reason>` in `warnings` without an image.
- Extraction failures on a still-current route return `viewport-only` results when a capture exists, instead of a blind text failure.

## Changes in v7.1

Version 7.1 preserves the v7 result contract while making its intended defaults and conservative PDF structure recovery explicit:

- The model-facing JSON Schema now carries the same defaults as runtime normalization, including `includePageImages: true`; providers with a reduced schema subset may drop the annotation but retain the explicit description.
- Tool guidance tells models to retain images for summaries and general reading; `false` is reserved for explicit user requests or recovery after an image failure.
- Sparse rotated marginalia no longer forces the entire page into source-order plain text.
- Isolated font-size evidence, numbered-section syntax, and bullet glyphs recover bounded Markdown structure without hardcoded document vocabulary or claims of authoritative PDF semantics.

## Migrating from v6

Version 7 preserves the HTML and PDF text contracts and adds default-on visual PDF context:

- `includePageImages` defaults to `true` for PDFs and may be set to `false` for text-only extraction.
- Each admitted PDF page has one low-detail full-page JPEG bounded to a 1,024-pixel longest edge and one megapixel.
- Public `pdf.pageImages` descriptors map ordered model media to canonical physical PDF page numbers without exposing bytes.
- Text and image admission is atomic: if a later page image cannot fit or be produced, that page is omitted and `nextPage` points to it; retry that page with `includePageImages: false` when text-only recovery is acceptable. A first-page image failure returns a typed error carrying the same recovery instruction.
- Visual-only pages succeed when an image is available and retain a `NO_PAGE_TEXT:page-N` warning; text-only calls preserve `NO_EXTRACTABLE_TEXT`.

## Migrating from v5

Version 6 preserved the HTML result contract and added the PDF branch under the same public tool name:

- Native PDF-viewer tabs no longer return the viewer shell as successful metadata extraction.
- `startPage` and `maxPages` provide bounded PDF pagination.
- PDF successes add `warnings`, `pdf`, and `stats.extractedPageCount` while preserving `success`, `metadata`, `markdownContent`, `truncated`, and the existing statistics.
- PDF failures use fixed typed codes such as `AUTH_REQUIRED`, `TOO_LARGE`, `COPY_NOT_PERMITTED`, `NO_EXTRACTABLE_TEXT`, `PARSE_FAILED`, `TIMEOUT`, and `NAVIGATED`.

Version 5 intentionally changed the HTML result contract:

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

Chrome exposes no cancellation handle for a running `chrome.scripting.executeScript()` function. HTML cancellation and the ten-second deadline therefore fence delivery and settlement at script boundaries but cannot preempt synchronous Readability work after it starts; exact-document navigation still revokes the result. Moving parsing away from the live document would sacrifice the layout-backed extraction contract and is intentionally out of scope.

PDF extraction does not execute PDF JavaScript, enable XFA, perform local OCR, infer ambiguous tables, or claim authoritative semantic structure. PDF.js exposes positioned glyph runs and sometimes a tagged structure tree, but many PDFs—including ordinary LaTeX papers—contain no semantic tags. AgentBoard therefore infers only high-confidence heading/list signals from geometry and generic numbered-section syntax; same-size unnumbered headings, font styling, paragraphs, tables, captions, footnotes, and reading order can still be ambiguous. Default low-detail page images let a capable model inspect scanned text, figures, photographs, charts, handwriting, annotations, signatures, visual redactions, and layout relationships, but this vision behavior is not represented as local OCR and may miss dense labels. Credentialed network reacquisition is limited to the exact current top-document URL and cannot reproduce POST bodies, one-use responses, transient authorization headers, or every partitioned authentication flow. Chrome’s file-scheme permission is necessarily broader than one path, but application logic accepts no model-selected local URL: it captures only the exact current top-level PDF and authenticates the extension host before disclosing that URL for local acquisition. Input is capped at 32 MiB; individual source raster images above 16 megapixels fail the visual path instead of being silently omitted; worker-side image canvases and output page canvases are resized to at most one megapixel; encoded page images are capped at 6 MiB per call before base64; text items and pages are bounded; copy-restricted documents fail closed; and navigation revokes settlement.

These boundaries avoid a custom visibility engine, ARIA-name implementation, DOM serializer, debugger permission, MIME-handler ownership, hidden PDFium reuse, raw HTML fallback, or heavyweight OCR/layout stack. Features outside these bounds should be separate explicit product decisions.

## Verification

`tests/webmcp-readability.test.ts` executes the production HTML extractor in JSDOM for result contracts, truncation, and failure recovery. `tests/pdf-formatter.test.ts` and `tests/pdf-read-page-adapter.test.ts` cover conservative geometry, MIME routing, pagination, cancellation, and document ownership. `tests/browser/read-page.html` exercises browser-owned `innerText`, layout visibility, native modal, and the built private HTML host; `tests/browser/mv3-extension.mjs` proves that the extension-owned public router reaches both private branches, remains authoritative over a same-name page registration, ignores MAIN-world monkey patches, performs authenticated native-viewer PDF extraction, and reads a real local file PDF through exact-document authority.

```bash
pnpm run test:browser
```

The browser command builds the extension first, runs without opening a window, and discovers Chrome or Chromium from common platform paths. Set `CHROME_BIN` when the executable lives elsewhere.

## Architecture and CSP

The public tab-bound router performs exact-document MIME detection before dispatch. For HTML, it injects a self-contained, idempotent classic-script host into the captured top document's ISOLATED world, invokes it by exact `documentId`, validates the one top-frame result, and rechecks route ownership before settlement. The host shares the live DOM and browser layout with the page but not page JavaScript globals, monkey patches, closures, framework state, or `document.modelContext`. For a local PDF without a WebMCP relay, the router performs one on-demand ISOLATED top-frame probe and captures Chromium’s `documentId`; it does not inject the generic MAIN-world bridge, polyfill, built-ins, or user scripts. The router then injects a separate self-contained PDF host, which mounts a capability-authenticated extension page inside a closed shadow root. The PDF-only web-accessible page stays a small bootstrap until the service worker consumes its one-time exact-document capability; network claims additionally require the original relay route, while relay-free local claims require Chromium’s current top-frame `documentId`. Only then does the host load the parser, receive any private local URL, and start one explicitly owned PDF.js worker per call. Network bytes cross only the private document-to-parser `MessagePort`; local bytes are fetched inside the claimed parser frame. Generic page-tool ingestion contains no `read_page` branch. Raw PDF bytes never traverse the service worker, generic message queue, logs, storage, or model context. Encoded page images cross the exact-document parser channel only long enough to enter a private model-output side channel; they never enter public tool results, sidebar messages, logs, or storage. Neither extraction branch uses `eval()` or `new Function()` at runtime.

**Readability source of truth:** `src/lib/webmcp/vendor/readability.js`

After updating the vendored library, copy it into `html-reader.js` as documented in [`vendor/README.md`](../../vendor/README.md).

## License

Mozilla Readability is licensed under Apache License 2.0.
