# DOM Query Tool

## Description

Query DOM elements using CSS selectors and extract structured information from them.

## Use Cases

- Web scraping and data extraction
- Testing and validation
- Content analysis
- UI automation support

## Parameters

- `selector` (string, required) - CSS selector to query elements
- `attribute` (string) - Specific attribute to extract
- `extractText` (boolean) - Extract text content
- `extractHtml` (boolean) - Extract inner HTML
- `limit` (number) - Maximum elements to return (default: 100, max: 1000)

## Return Values

Returns an object containing:

- `selector` - The selector used
- `found` - Total number of matching elements
- `returned` - Number of elements returned
- `elements` - Array of element data:
  - `tagName` - Element tag name
  - `id` - Element ID if present
  - `className` - Element classes if present
  - `attribute` - Requested attribute value
  - `text` - Text content (if requested)
  - `html` - Inner HTML (if requested)
  - `visible` - Whether element is visible
  - `position` - Bounding rectangle for visible elements

## Examples

```javascript
// Find all links
const links = await window.agent.callTool('dom-query', {
  selector: 'a[href]',
  attribute: 'href',
  extractText: true,
});

// Get form inputs
const inputs = await window.agent.callTool('dom-query', {
  selector: 'input, textarea, select',
  attribute: 'name',
  limit: 50,
});

// Extract article content
const articles = await window.agent.callTool('dom-query', {
  selector: 'article, [role="article"], .post, .entry',
  extractText: true,
  extractHtml: true,
  limit: 10,
});
```

## Limitations

- Limited to 1000 elements maximum
- Large HTML extractions may impact performance
- Position data only available for visible elements
