/**
 * System Tool: URL Fetch for LLM Research
 *
 * Executes in background service worker to avoid CORS restrictions.
 * Provides raw content by default, optional markdown conversion via linkedom + Readability.
 *
 * Pre-converted to AI SDK format for direct use in tool registry.
 */

import { raceWithAbort } from '../../../abort';
import log from '../../../logger';
import { ConfigStorage } from '../../../storage/config';
import { convertToMarkdown } from './content-extractor';
import { tool } from 'ai';
import { z } from 'zod';

export const FETCH_URL_TOOL_NAME = 'agentboard_fetch_url';
const TOOL_VERSION = '1.0.0';
const TOOL_DESCRIPTION =
  'Fetch content from external URLs. For the current page, prefer site-specific tools instead. ' +
  'Returns raw content or optionally converts HTML to clean markdown.';

const PARAM_DESCRIPTIONS = {
  url: 'URL to fetch (supports HTTPS URLs, including private IPs, and HTTP localhost URLs)',
  convertToMarkdown:
    'Convert HTML content to markdown format with metadata (default: false). ' +
    'Extracts article content, strips ads/navigation, formats as clean markdown.',
} as const;

/**
 * Zod schema for fetch URL arguments
 * Descriptions are imported from PARAM_DESCRIPTIONS to avoid duplication
 */
const fetchUrlSchema = z.object({
  url: z.string().describe(PARAM_DESCRIPTIONS.url),
  convertToMarkdown: z.boolean().optional().describe(PARAM_DESCRIPTIONS.convertToMarkdown),
});

/**
 * Execute fetch URL operation
 */
async function executeFetchUrl(
  args: z.infer<typeof fetchUrlSchema>,
  { abortSignal }: { abortSignal?: AbortSignal } = {}
): Promise<string> {
  const { url, convertToMarkdown: shouldConvert } = args;

  log.debug('[fetch_url] Fetching:', url, {
    convertToMarkdown: shouldConvert,
  });

  try {
    const isEnabled = await raceWithAbort(
      ConfigStorage.getInstance().isBuiltinToolEnabled(FETCH_URL_TOOL_NAME),
      abortSignal
    );
    if (!isEnabled) throw new Error('Tool disabled');

    // Match manifest host permissions instead of promising fetches Chromium will reject.
    const parsedUrl = new URL(url);
    if (
      parsedUrl.protocol !== 'https:' &&
      !(parsedUrl.protocol === 'http:' && parsedUrl.hostname === 'localhost')
    ) {
      throw new Error('Unsupported URL');
    }

    // Get version from manifest dynamically (falls back for tests)
    const version =
      typeof chrome !== 'undefined' && chrome.runtime?.getManifest
        ? chrome.runtime.getManifest().version
        : '0.1.0';

    // Model-selected URLs are never allowed to inherit browser session credentials.
    const response = await globalThis.fetch(url, {
      credentials: 'omit',
      signal: abortSignal,
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
  } catch {
    log.error('[fetch_url] Request failed');
    throw new Error('URL fetch failed');
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
    },
    required: ['url'],
  },
};

/**
 * Export execute function for testing
 */
export { executeFetchUrl };
