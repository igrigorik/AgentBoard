'use webmcp-tool v1';

export const metadata = {
  name: 'page_info',
  namespace: 'agentboard',
  version: '1.0.0',
  description: 'Extract metadata, title, and Open Graph tags from current tab.',
  match: ['<all_urls>'],
  inputSchema: {
    type: 'object',
    properties: {
      includeMetaTags: {
        type: 'boolean',
        description: 'Include all meta tags in the response'
      },
      includeOpenGraph: {
        type: 'boolean',
        description: 'Include Open Graph tags in the response'
      }
    },
    additionalProperties: false
  }
};

export async function execute(args = {}) {
  const result = {
    title: document.title || '',
    url: window.location.href,
    description: '',
    charset: document.characterSet,
    language: document.documentElement.lang || ''
  };

  // Get meta description
  const descriptionMeta = document.querySelector('meta[name="description"]');
  if (descriptionMeta) {
    result.description = descriptionMeta.content;
  }

  // Get all meta tags if requested
  if (args.includeMetaTags) {
    result.metaTags = {};
    document.querySelectorAll('meta[name]').forEach(meta => {
      const name = meta.getAttribute('name');
      result.metaTags[name] = meta.content;
    });
  }

  // Get Open Graph tags if requested
  if (args.includeOpenGraph) {
    result.openGraph = {};
    document.querySelectorAll('meta[property^="og:"]').forEach(meta => {
      const property = meta.getAttribute('property');
      result.openGraph[property] = meta.content;
    });

    // Also check for Twitter Card tags
    result.twitterCard = {};
    document.querySelectorAll('meta[name^="twitter:"]').forEach(meta => {
      const name = meta.getAttribute('name');
      result.twitterCard[name] = meta.content;
    });
  }

  // Get canonical URL if present
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) {
    result.canonical = canonical.href;
  }

  // Get favicon
  const favicon = document.querySelector('link[rel*="icon"]');
  if (favicon) {
    result.favicon = favicon.href;
  }

  return result;
}
