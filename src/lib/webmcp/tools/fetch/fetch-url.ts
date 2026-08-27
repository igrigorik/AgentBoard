/**
 * System Tool: URL Fetch for LLM Research
 *
 * Executes in background service worker to avoid CORS restrictions.
 * Returns structured HTTP status metadata with raw content or optional markdown extraction.
 *
 * Pre-converted to AI SDK format for direct use in tool registry.
 */

import { raceWithAbort } from '../../../abort';
import log from '../../../logger';
import { ConfigStorage } from '../../../storage/config';
import { convertToMarkdown } from './content-extractor';
import { tool } from 'ai';
import { z } from 'zod';
import {
  FETCH_URL_DESCRIPTION,
  FETCH_URL_PARAMETER_DESCRIPTIONS,
  FETCH_URL_TOOL_NAME,
} from './metadata';

/**
 * Zod schema for fetch URL arguments
 * Descriptions are imported from the metadata leaf to avoid duplication
 */
const fetchUrlSchema = z.object({
  url: z.string().describe(FETCH_URL_PARAMETER_DESCRIPTIONS.url),
  convertToMarkdown: z
    .boolean()
    .optional()
    .describe(FETCH_URL_PARAMETER_DESCRIPTIONS.convertToMarkdown),
});

export const fetchUrlOutputSchema = z.object({
  status: z.number().int().min(0).max(999).describe('HTTP response status code'),
  statusText: z.string().optional().describe('HTTP response reason phrase when available'),
  content: z.string().describe('Raw response body or extracted markdown'),
});

export type FetchUrlResult = z.infer<typeof fetchUrlOutputSchema>;

/**
 * Execute fetch URL operation
 */
async function executeFetchUrl(
  args: z.infer<typeof fetchUrlSchema>,
  { abortSignal }: { abortSignal?: AbortSignal } = {}
): Promise<FetchUrlResult> {
  const { url, convertToMarkdown: shouldConvert } = args;

  log.debug('[fetch_url] Fetching', {
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

    // A completed HTTP response is evidence, even when its status is non-2xx.
    abortSignal?.throwIfAborted();
    const content = await raceWithAbort(response.text(), abortSignal);
    abortSignal?.throwIfAborted();

    log.debug('[fetch_url] Fetched', content.length, 'bytes');

    let result = content;
    if (shouldConvert && content.length > 0) {
      log.debug('[fetch_url] Converting to markdown');
      result = convertToMarkdown(content, { url });
      log.debug('[fetch_url] Converted to', result.length, 'characters');
    }

    abortSignal?.throwIfAborted();
    const statusText = response.statusText.trim();
    return {
      status: response.status,
      ...(statusText && { statusText }),
      content: result,
    };
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
  description: FETCH_URL_DESCRIPTION,
  inputSchema: fetchUrlSchema,
  outputSchema: fetchUrlOutputSchema,
  execute: executeFetchUrl,
});

/**
 * Export execute function for testing
 */
export { executeFetchUrl };
