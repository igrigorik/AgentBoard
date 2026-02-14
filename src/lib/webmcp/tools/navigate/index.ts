/**
 * System Tool: Tab Navigation
 *
 * Executes in background service worker using chrome.tabs.update().
 * Waits for full page load (onCompleted) before returning.
 *
 * Design: Factory pattern because the tool needs a tabId that's only known
 * at stream time, not at global registry initialization. The tool is injected
 * into allTools per-stream in client.ts, not registered in ToolRegistryManager.
 *
 * Lifecycle sequence:
 * 1. chrome.tabs.update(tabId, { url })
 * 2. onBeforeNavigate fires → old tools cleared → toolsInvalidated flag set
 * 3. waitForNavigation waits for onCompleted
 * 4. Tool returns result (step finishes)
 * 5. stopWhen detects toolsInvalidated → stream stops
 * 6. Sidebar auto-continues with fresh tools from new page
 */

import log from '../../../logger';
import { getTabManager } from '../../lifecycle';
import { tool } from 'ai';
import { z } from 'zod';

export const NAVIGATE_TOOL_NAME = 'agentboard_navigate';
const TOOL_VERSION = '1.0.0';
const TOOL_DESCRIPTION =
  'Navigate the current browser tab to a new URL. Waits for the page to fully load before returning. ' +
  'After navigation, call read_page to get the new page content and inspect new set of available tools.';

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
    execute: async (args) => {
      const { url } = args;
      log.info(`[navigate] Navigating tab ${tabId} to ${url}`);

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
      const navigationPromise = tabManager.waitForNavigation(tabId);

      // Initiate navigation — triggers onBeforeNavigate (clears old tools)
      await chrome.tabs.update(tabId, { url });

      // Wait for navigation to complete (onCompleted for main frame)
      const result = await navigationPromise;

      // Get page title after load
      const tab = await chrome.tabs.get(tabId);

      const summary = `Navigated to ${result.url}${tab.title ? ` — "${tab.title}"` : ''}`;
      log.info(`[navigate] ${summary}`);
      return summary;
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
