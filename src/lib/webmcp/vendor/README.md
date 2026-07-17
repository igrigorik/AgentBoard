# WebMCP Vendor Dependencies

Third-party libraries shared across WebMCP tools.

## Readability.js

**Vendored version:** Mozilla Readability v0.6.0

**Package:** `@mozilla/readability@0.6.0`

**npm integrity:** `sha512-juG5VWh4qAivzTAeMzvY9xs9HY5rAcr2E4I7tiSSCokRFi7XIZCAu92ZkSTsIj1OPceCifL3cpfteP3pDT9/QQ==`

**License:** Apache License 2.0

**Source:** https://github.com/mozilla/readability

### Consumers

- `tools/read_page/script.js` contains an inlined copy for CSP-safe MAIN-world injection.
- `tools/fetch/content-extractor.ts` imports the vendored ES module in the service worker.

### Files

- `readability.js`: Canonical vendored source with an ES module export.
- `readability.d.ts`: TypeScript declarations.

Version 0.6.0 resolves [CVE-2025-2792](https://github.com/advisories/GHSA-3p6v-hrg8-8qj7), a title-parsing denial of service that affects earlier package versions and is reachable through untrusted HTML in the fetch pipeline.

### Updating Readability

Updating the package is not a blind copy operation. The inlined `read_page` copy has Trusted Types wrappers around Readability's `innerHTML` sinks; those local compatibility patches must survive an update.

1. Download the exact npm package into a temporary directory and verify its published integrity before extracting `Readability.js`.
2. Replace the upstream implementation in `vendor/readability.js`, retaining AgentBoard's outer ESLint guard, provenance header, and `export { Readability };` footer.
3. Remove upstream `eslint-disable-next-line` annotations that are redundant inside AgentBoard's outer vendored-code guard; with `reportUnusedDisableDirectives`, leaving both layers fails lint.
4. Copy the same implementation into `tools/read_page/script.js` between the vendored-library markers, preserving the outer `/* eslint-disable */` guard.
5. Reapply `_safeHTML(...)` at every Readability `innerHTML` assignment in the inlined copy. At v0.6.0 these remain the page-cache restoration and `<noscript>` image-recovery paths.
6. Keep the `window.Readability = Readability` attachment after the inlined implementation.
7. Update `readability.d.ts` for upstream API changes and update version/integrity references in the vendor files and inlined header.
8. Run the synchronization, security-regression, consumer, and real-browser tests:

```bash
pnpm exec vitest --run tests/readability-vendor.test.ts tests/webmcp-readability.test.ts tests/webmcp-fetch-url.test.ts
pnpm run test:browser
```

The synchronization test treats the two `_safeHTML(...)` wrappers as the only permitted implementation difference between the canonical and inlined copies. Review any additional difference rather than normalizing it away: the wrappers are required by extension execution on Trusted Types-enforcing sites such as Gmail.

### Why vendor it?

The two consumers have different execution constraints:

1. Service-worker code can use an ES module import.
2. A built-in WebMCP tool must be self-contained so `chrome.scripting.executeScript({ files: [...] })` can inject it without violating the page's Content Security Policy.

The controlled duplication is limited to the vendored Readability implementation and the small context-specific HTML-to-Markdown converters.
