# WebMCP Vendor Dependencies

Third-party libraries shared across WebMCP tools.

## Readability.js

**Vendored version:** Mozilla Readability v0.5.0

**License:** Apache License 2.0

**Source:** https://github.com/mozilla/readability

### Consumers

- `tools/read_page/script.js` contains an inlined copy for CSP-safe MAIN-world injection.
- `tools/fetch/content-extractor.ts` imports the vendored ES module in the service worker.

### Files

- `readability.js`: Canonical vendored source with an ES module export.
- `readability.d.ts`: TypeScript declarations.

### Updating Readability

Updating the package is not a blind copy operation. The inlined `read_page` copy has Trusted Types wrappers around Readability's `innerHTML` sinks; those local compatibility patches must survive an update.

1. Download the desired upstream `Readability.js` into a temporary file.
2. Replace the upstream implementation in `vendor/readability.js`, retaining the license header and `export { Readability };` footer.
3. Copy the implementation into `tools/read_page/script.js` between the vendored-library markers.
4. Reapply `_safeHTML(...)` at every Readability `innerHTML` assignment in the inlined copy. At v0.5.0 these include the page-cache restoration and `<noscript>` image-recovery paths.
5. Keep the `window.Readability = Readability` attachment after the inlined implementation.
6. Update `readability.d.ts` if the upstream API changed.
7. Update version references in `vendor/readability.js`, `tools/read_page/script.js`, and `tools/read_page/README.md`.
8. Run both consumers' tests and the extension build:

```bash
pnpm exec vitest --run tests/webmcp-readability.test.ts tests/webmcp-fetch-url.test.ts
pnpm run test:browser
```

Review the final diff rather than assuming the copies match byte-for-byte: the Trusted Types wrappers are intentional differences required by extension execution on enforcing sites such as Gmail.

### Why vendor it?

The two consumers have different execution constraints:

1. Service-worker code can use an ES module import.
2. A built-in WebMCP tool must be self-contained so `chrome.scripting.executeScript({ files: [...] })` can inject it without violating the page's Content Security Policy.

The controlled duplication is limited to the vendored Readability implementation and the small context-specific HTML-to-Markdown converters.
