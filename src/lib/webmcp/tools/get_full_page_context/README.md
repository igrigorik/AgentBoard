# dom_readability Tool v2.1

A WebMCP tool that extracts readable article content from web pages using Mozilla's Readability library, optimized for LLM consumption.

## Architecture

This tool inlines the entire Readability library directly into `script.js` for CSP compatibility. Unlike dynamic eval/Function approaches, this bypasses Content Security Policy restrictions on sites like ChatGPT.com and GitHub.com.

## File Structure

```
dom_readability/
├── script.js              # Complete tool with inlined Readability (canonical source)
└── README.md              # This documentation
../../vendor/
└── readability.js         # Mozilla Readability v0.5.0 (shared source of truth)
```

## Usage

```javascript
// Simple - just one optional parameter
const result = await window.agent.callTool('agentboard_dom_readability', {
  maxLength: 10000, // Optional, defaults to unlimited
});
```

## Output Structure

```javascript
{
  success: true,           // Whether extraction succeeded
  readable: true,          // Whether page contains article content

  // Rich metadata (always included)
  metadata: {
    // Core article info
    title: "Article Title",
    byline: "Author Name",
    excerpt: "Brief description...",
    siteName: "Example.com",
    publishedTime: "2024-01-15T10:00:00Z",

    // Additional metadata
    description: "Meta description",
    keywords: "tech, ai, development",
    author: "Author Name",

    // Open Graph data (often more accurate)
    ogTitle: "Open Graph Title",
    ogDescription: "OG description",
    ogImage: "https://example.com/image.jpg",
    ogType: "article",

    // Article-specific
    modifiedTime: "2024-01-20T15:00:00Z",
    section: "Technology",
    tags: "ai, machine-learning",

    // Technical info
    language: "en",
    direction: "ltr",
    charset: "UTF-8",
    url: "https://example.com/article",
    domain: "example.com",

    // Extraction metadata
    extractedAt: "2024-01-25T12:00:00Z",
    readabilityConfig: { /* config used */ }
  },

  // Self-contained markdown with metadata header
  markdownContent: "# Article Title\n*By Author*\n*Published: 2024-01-15*\n*Source: https://example.com*\n\n---\n\n## Introduction\n\nArticle content...",

  // Statistics
  stats: {
    characterCount: 5000,
    wordCount: 1000,
    estimatedReadTime: 5,  // minutes
    imageCount: 3,
    linkCount: 10
  },

  // Additional formats (if needed)
  alternateFormats: {
    html: "<h2>Introduction</h2>...",
    text: "Introduction Article content..."
  }
}
```

## Optimal Default Settings

The tool uses carefully chosen defaults that work well across diverse content:

| Setting               | Value | Rationale                                             |
| --------------------- | ----- | ----------------------------------------------------- |
| `charThreshold`       | 100   | Balances catching short docs vs avoiding navigation   |
| `nbTopCandidates`     | 10    | Handles complex layouts without performance penalty   |
| `linkDensityModifier` | -0.1  | Slightly permissive for technical docs with citations |
| `includeLinks`        | false | URLs are noise for LLMs in most cases                 |
| `simpleTables`        | true  | Pipe-separated format clearer than HTML tables        |

## Examples

### Basic Extraction

```javascript
const result = await window.agent.callTool('agentboard_dom_readability', {});

if (result.success) {
  console.log('Title:', result.metadata.title);
  console.log('Content:', result.markdownContent);
}
```

### With Length Limit

```javascript
const result = await window.agent.callTool('agentboard_dom_readability', {
  maxLength: 5000, // ~1000 tokens for LLM
});
```

### Quality Check

```javascript
const result = await window.agent.callTool('agentboard_dom_readability', {});

if (result.success && result.stats.wordCount > 300) {
  // Good quality article
  sendToLLM(result.markdownContent); // Already includes metadata header
} else if (!result.readable) {
  // Not an article page
  console.log('Page type:', result.metadata.ogType || 'unknown');
}
```

## Updating Readability Version

This tool uses Mozilla Readability for content extraction. The vendor code lives in a shared location.

**Source of truth:** `src/lib/webmcp/vendor/readability.js`

For update instructions, see **[vendor/README.md](../../vendor/README.md)**

After updating the vendor file, you must manually update the inlined copy in this tool's `script.js` (lines containing the Readability function). This is necessary for CSP-safe injection.

## Technical Notes

### CSP Compatibility

This tool works on strict CSP sites (ChatGPT.com, GitHub.com) because:

- The entire Readability library is inlined directly in `script.js`
- The compiled tool is injected via `chrome.scripting.executeScript({ files: [...] })`
- Chrome treats file-based injection as trusted extension code
- No `eval()` or `new Function()` is used (CSP safe!)

### Performance

- Tool registers instantly on page load (<10ms)
- Execution time varies by page complexity (typically 50-500ms)
- Readability library is ~84KB, included in every page (acceptable for the functionality)

## License

Mozilla Readability is licensed under Apache 2.0. This tool follows the same license.
