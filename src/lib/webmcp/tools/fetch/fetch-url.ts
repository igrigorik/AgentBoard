/**
 * System Tool: URL Fetch for LLM Research
 *
 * Executes in background service worker to avoid CORS restrictions.
 * Provides raw content by default, optional markdown conversion via linkedom + Readability.
 *
 * Pre-converted to AI SDK format for direct use in tool registry.
 */

import log from '../../../logger';
import { convertToMarkdown } from './content-extractor';
import { tool } from 'ai';
import { z } from 'zod';

export const FETCH_URL_TOOL_NAME = 'agentboard_fetch_url';
const TOOL_VERSION = '1.0.0';
const TOOL_DESCRIPTION =
  'Fetch content from external URLs (not the current page). ' +
  'For current page content, use site-specific or agentboard_dom_* tools instead. ' +
  'Returns raw content (HTML, JSON, etc.) or optionally converts to markdown.';

const PARAM_DESCRIPTIONS = {
  url: 'URL to fetch (supports http, https, localhost, private IPs)',
  convertToMarkdown:
    'Convert HTML content to markdown format with metadata (default: false). ' +
    'Extracts article content, strips ads/navigation, formats as clean markdown.',
  includeCredentials:
    'Include cookies and authentication headers (default: true). ' +
    'Set to false for unauthenticated requests.',
} as const;

/**
 * Zod schema for fetch URL arguments
 * Descriptions are imported from PARAM_DESCRIPTIONS to avoid duplication
 */
const fetchUrlSchema = z.object({
  url: z.string().describe(PARAM_DESCRIPTIONS.url),
  convertToMarkdown: z.boolean().optional().describe(PARAM_DESCRIPTIONS.convertToMarkdown),
  includeCredentials: z.boolean().optional().describe(PARAM_DESCRIPTIONS.includeCredentials),
});

/**
 * Execute fetch URL operation
 */
async function executeFetchUrl(args: z.infer<typeof fetchUrlSchema>): Promise<string> {
  const { url, convertToMarkdown: shouldConvert, includeCredentials = true } = args;

  log.debug('[fetch_url] Fetching:', url, {
    convertToMarkdown: shouldConvert,
    includeCredentials,
  });

  try {
    // Validate URL
    new URL(url); // Throws if invalid

    // Get version from manifest dynamically (falls back for tests)
    const version =
      typeof chrome !== 'undefined' && chrome.runtime?.getManifest
        ? chrome.runtime.getManifest().version
        : '0.1.0';

    // Fetch with appropriate credentials mode
    // Note: Service workers have fetch in global scope
    const response = await globalThis.fetch(url, {
      credentials: includeCredentials ? 'include' : 'omit',
      headers: {
        'User-Agent': `AgentBoard/${version}`,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText} (${url})`);
    }

    // Get content as text (works for HTML, JSON, XML, plain text)
    const content = await response.text();

    log.debug('[fetch_url] Fetched', content.length, 'bytes');

    // Return raw content unless markdown conversion requested
    if (!shouldConvert) {
      return content;
    }

    // Convert to markdown using extraction pipeline
    log.debug('[fetch_url] Converting to markdown');
    const markdown = convertToMarkdown(content, { url });

    log.debug('[fetch_url] Converted to', markdown.length, 'characters');
    return markdown;
  } catch (error) {
    log.error('[fetch_url] Error:', error);
    throw new Error(
      `Failed to fetch ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Fetch URL tool - pre-converted to AI SDK format
 * Ready for direct registration in tool registry
 */
export const fetchUrlTool = tool({
  description: TOOL_DESCRIPTION,
  inputSchema: fetchUrlSchema,
  execute: executeFetchUrl,
});

/**
 * Tool metadata for display purposes (Options UI)
 * References the same constants as the tool definition above
 */
export const FETCH_URL_METADATA = {
  description: TOOL_DESCRIPTION,
  version: TOOL_VERSION,
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: PARAM_DESCRIPTIONS.url,
      },
      convertToMarkdown: {
        type: 'boolean',
        description: PARAM_DESCRIPTIONS.convertToMarkdown,
      },
      includeCredentials: {
        type: 'boolean',
        description: PARAM_DESCRIPTIONS.includeCredentials,
      },
    },
    required: ['url'],
  },
};

/**
 * Export execute function for testing
 */
export { executeFetchUrl };
