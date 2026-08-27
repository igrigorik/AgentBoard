/**
 * UI-facing fetch_url metadata leaf.
 *
 * The Options page renders this through builtin-tools.ts, so this module must
 * not import the tool implementation: fetch-url.ts drags `ai`, zod, and the
 * linkedom/Readability extraction stack into every bundle that evaluates it.
 * Implementation imports these constants to stay single-source-of-truth.
 * Guarded by tests/options-import-graph.test.ts.
 */

export const FETCH_URL_TOOL_NAME = 'agentboard_fetch_url';
export const FETCH_URL_VERSION = '1.0.0';
export const FETCH_URL_DESCRIPTION =
  'Fetch content from external URLs. For the current page, prefer site-specific tools instead. ' +
  'Returns a structured result with HTTP status metadata plus raw content, or clean markdown when requested. ' +
  'Non-2xx responses still return any available content.';

export const FETCH_URL_PARAMETER_DESCRIPTIONS = {
  url: 'URL to fetch (supports HTTPS URLs, including private IPs, and HTTP localhost URLs)',
  convertToMarkdown:
    'Convert HTML content to markdown format with metadata (default: false). ' +
    'Extracts article content, strips ads/navigation, formats as clean markdown.',
} as const;

export const FETCH_URL_METADATA = {
  description: FETCH_URL_DESCRIPTION,
  version: FETCH_URL_VERSION,
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: FETCH_URL_PARAMETER_DESCRIPTIONS.url,
      },
      convertToMarkdown: {
        type: 'boolean',
        description: FETCH_URL_PARAMETER_DESCRIPTIONS.convertToMarkdown,
      },
    },
    required: ['url'],
  },
};
