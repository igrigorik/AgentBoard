/**
 * System Tool: Tab Navigation
 *
 * Executes in background service worker using chrome.tabs.update().
 * Waits for full page load (onCompleted) before returning.
 *
 * Design: Factory pattern because the tool needs a tabId that's only known
 * at stream time. ToolRegistry registers the factory globally and materializes
 * a tab-bound tool for each stream.
 *
 * Lifecycle sequence:
 * 1. chrome.tabs.update(tabId, { url })
 * 2. onBeforeNavigate fires → old tools cleared → toolsInvalidated flag set
 * 3. waitForNavigation waits for onCompleted
 * 4. Tool returns result (step finishes)
 * 5. stopWhen detects toolsInvalidated → stream stops
 * 6. Sidebar auto-continues with fresh tools from new page
 */

import { raceWithAbort } from '../../../abort';
import log from '../../../logger';
import { ConfigStorage } from '../../../storage/config';
import { getTabManager } from '../../lifecycle';
import { tool } from 'ai';
import { z } from 'zod';

export const NAVIGATE_TOOL_NAME = 'agentboard_navigate';
const TOOL_VERSION = '1.0.0';
const TOOL_DESCRIPTION =
  'Navigate the current browser tab to a URL and wait for the page to load. ' +
  'After navigation, available tools may change. Use the appropriate tool to acquire context from the new page.';

const PARAM_DESCRIPTIONS = {
  url: 'The URL to navigate to. Must be a full valid URL (e.g., https://example.com).',
} as const;

const navigateSchema = z.object({
  url: z.string().describe(PARAM_DESCRIPTIONS.url),
});

/**
 * Create a navigate tool bound to a specific tab.
 * Returns an AI SDK tool with the tabId captured in its execute closure.
 */
export function createNavigateTool(tabId: number) {
  return tool({
    description: TOOL_DESCRIPTION,
    inputSchema: navigateSchema,
    execute: async (args, { abortSignal }: { abortSignal?: AbortSignal } = {}) => {
      const { url } = args;
      log.info(`[navigate] Navigating tab ${tabId} to ${url}`);

      const isEnabled = await raceWithAbort(
        ConfigStorage.getInstance().isBuiltinToolEnabled(NAVIGATE_TOOL_NAME),
        abortSignal
      );
      if (!isEnabled) throw new Error('Tool disabled');

      // Validate URL — only allow http/https to prevent dangerous schemes
      // (javascript:, data:, file://, chrome-extension:// etc.)
      const parsed = new URL(url); // throws on invalid
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`Only http and https URLs are supported. Got: ${parsed.protocol}`);
      }

      // Register navigation listener BEFORE triggering navigation.
      // chrome.tabs.update resolves when the tab object updates, not when
      // navigation completes. For fast navigations (cached, hash change),
      // onCompleted can fire before the next microtask — registering after
      // would miss the event entirely.
      const tabManager = getTabManager();
      const navigationController = new AbortController();
      const abortNavigation = () => navigationController.abort();
      if (abortSignal?.aborted) abortNavigation();
      else abortSignal?.addEventListener('abort', abortNavigation, { once: true });

      try {
        const navigationPromise = tabManager.waitForNavigation(
          tabId,
          30000,
          navigationController.signal
        );

        const [, result] = await Promise.all([
          raceWithAbort(chrome.tabs.update(tabId, { url }), abortSignal),
          navigationPromise,
        ]);

        const tab = await raceWithAbort(chrome.tabs.get(tabId), abortSignal);
        const summary = `Navigated to ${result.url}${tab.title ? ` — "${tab.title}"` : ''}`;
        log.info(`[navigate] ${summary}`);
        return summary;
      } finally {
        abortSignal?.removeEventListener('abort', abortNavigation);
        // A failed tabs.update must not leave the navigation timer/listeners alive.
        abortNavigation();
      }
    },
  });
}

/**
 * Tool metadata for display in Options UI.
 * Matches the shape used by fetch_url's FETCH_URL_METADATA.
 */
export const NAVIGATE_TOOL_METADATA = {
  description: TOOL_DESCRIPTION,
  version: TOOL_VERSION,
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: PARAM_DESCRIPTIONS.url,
      },
    },
    required: ['url'],
  },
};
