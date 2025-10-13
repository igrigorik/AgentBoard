# WebMCP Vendor Dependencies

Third-party libraries shared across WebMCP tools.

## Readability.js

**Current Version:** Mozilla Readability v0.5.0  
**License:** Apache License 2.0  
**Source:** https://github.com/mozilla/readability

### What It Does

Extracts article content from web pages, stripping ads, navigation, and other non-content elements. Used by:

- `tools/dom_readability/script.js` - Inlined copy (for CSP-safe injection in page context)
- `tools/fetch/content-extractor.ts` - Direct import (service worker context)

### Files

- `readability.js` - Source of truth, ES module export added
- `readability.d.ts` - TypeScript type declarations

### Updating to New Version

When Mozilla releases a new Readability version:

**1. Download new version:**

```bash
cd src/lib/webmcp/vendor
curl -o readability-new.js \
  https://unpkg.com/@mozilla/readability@NEW_VERSION/Readability.js
```

**2. Prepare for ES module usage:**

```bash
# Add header
cat > readability.js << 'EOF'
/* eslint-disable */
/**
 * Mozilla Readability vNEW_VERSION (Apache License 2.0)
 *
 * SINGLE SOURCE OF TRUTH for Readability vendor code
 * Used by:
 * - fetch/content-extractor.ts (imports directly via ES module)
 * - dom_readability/script.js (inlined copy for CSP-safe injection)
 *
 * See vendor/README.md for update instructions
 */
EOF

# Append downloaded code
cat readability-new.js >> readability.js

# Add ES module export
cat >> readability.js << 'EOF'

// Export for ES module usage
export { Readability };
EOF

# Clean up
rm readability-new.js
```

**3. Update inlined copy in dom_readability/script.js:**

```bash
cd ../tools/dom_readability

# Open script.js and replace lines containing Readability function
# Keep the window attachment and execute function at the bottom
# Look for section starting with "function Readability(doc, options)"
# Replace until the end of "Readability.prototype = { ... };"
```

**4. Update TypeScript declarations if API changed:**
Edit `vendor/readability.d.ts` to match any new properties/methods.

**5. Test both consumers:**

```bash
npm run build
npm test -- webmcp-readability  # Page context (dom_readability)
npm test -- webmcp-fetch-url     # Service worker (fetch)
```

**6. Update version references:**

- Header comment in `vendor/readability.js`
- Header comment in `tools/dom_readability/script.js`

### Why Vendor Directory?

**Single source of truth:** One canonical copy prevents version drift between tools.

**Two consumption models:**

1. **ES module import:** Service worker code (`fetch/`) imports directly
2. **Inlined copy:** WebMCP tools (`dom_readability/`) inline for CSP-safe injection

WebMCP tools must be self-contained (no imports) to work via `chrome.scripting.executeScript({ files: [...] })` which bypasses Content Security Policy restrictions on strict sites (GitHub, ChatGPT, etc).

### Architecture Decision

Controlled duplication accepted:

- **Readability (2300+ LOC):** ✅ Single source in vendor/, copied to script.js when needed
- **htmlToMarkdown (~100 LOC):** Duplicated between tools due to context requirements (page vs service worker)
