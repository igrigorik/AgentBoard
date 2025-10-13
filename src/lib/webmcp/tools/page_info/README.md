# Page Info Tool

## Description

Extracts comprehensive page metadata including title, description, meta tags, and Open Graph information.

## Use Cases

- SEO analysis and auditing
- Content scraping and indexing
- Social media preview extraction
- Page metadata validation

## Parameters

- `includeMetaTags` (boolean) - Include all meta tags in response
- `includeOpenGraph` (boolean) - Include Open Graph and Twitter Card tags

## Return Values

Returns an object containing:

- `title` - Page title
- `url` - Current URL
- `description` - Meta description
- `charset` - Document character encoding
- `language` - Page language
- `canonical` - Canonical URL if present
- `favicon` - Favicon URL if present
- `metaTags` - All meta tags (if requested)
- `openGraph` - Open Graph tags (if requested)
- `twitterCard` - Twitter Card tags (if requested)

## Examples

```javascript
// Basic usage
const info = await window.agent.callTool('page-info', {});

// With all metadata
const fullInfo = await window.agent.callTool('page-info', {
  includeMetaTags: true,
  includeOpenGraph: true,
});
```

## Limitations

- Only reads meta tags present in the initial HTML
- Dynamic meta tags added via JavaScript may not be captured
- Works on all URLs (no restrictions)
