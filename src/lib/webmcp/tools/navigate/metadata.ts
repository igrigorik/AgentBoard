/**
 * UI-facing navigate metadata leaf.
 *
 * The Options page renders this through builtin-tools.ts, so this module must
 * not import the tool implementation: navigate's factory drags `ai`, zod, and
 * the WebMCP lifecycle/tool-registry graph into every bundle that evaluates
 * it. Implementation imports these constants to stay single-source-of-truth.
 * Guarded by tests/options-import-graph.test.ts.
 */

export const NAVIGATE_TOOL_NAME = 'agentboard_navigate';
export const NAVIGATE_VERSION = '1.0.0';
export const NAVIGATE_DESCRIPTION =
  'Navigate the current browser tab to a URL and wait for the page to load. ' +
  'After navigation, available tools may change. Use the appropriate tool to acquire context from the new page.';

export const NAVIGATE_PARAMETER_DESCRIPTIONS = {
  url: 'The URL to navigate to. Must be a full valid URL (e.g., https://example.com).',
} as const;

export const NAVIGATE_TOOL_METADATA = {
  description: NAVIGATE_DESCRIPTION,
  version: NAVIGATE_VERSION,
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: NAVIGATE_PARAMETER_DESCRIPTIONS.url,
      },
    },
    required: ['url'],
  },
};
