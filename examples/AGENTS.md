# WebMCP Tool Development Guide

This guide covers how to create custom WebMCP tools that run in the browser context and are available to the LLM for execution.

> **Spec Alignment**: This implementation aligns with the [WebMCP proposed spec](https://github.com/webmachinelearning/webmcp/blob/main/docs/proposal.md).

## Basic Structure

Every WebMCP tool is a JavaScript file with two required exports:

```javascript
'use webmcp-tool v1';

export const metadata = {
  name: 'tool_name', // Snake_case, unique within namespace
  namespace: 'my_namespace', // Groups related tools, appears in tool ID
  version: '1.0.0', // Semver
  description: 'What this tool does. Be specific - the LLM reads this.',
  match: 'https://example.com/*', // URL pattern(s) where tool is available
  inputSchema: {
    type: 'object',
    properties: {
      // JSON Schema for tool arguments
    },
    additionalProperties: false,
  },
};

// Per WebMCP spec: execute receives (args, agent) where agent provides requestUserInteraction()
export async function execute(args = {}, agent) {
  // Tool implementation - has full DOM/window access
  // Use agent.requestUserInteraction() for user confirmation flows
  // Return result object
}
```

The tool ID becomes `{namespace}_{name}` (e.g., `myapp_get_context`).

## Metadata Fields

### `name` (required)

- Use `snake_case`
- Should describe the tool's function: `document_context`, `get_messages`, `extract_data`

### `namespace` (required)

- Groups related tools: `myapp`, `github`, `jira`, `notion`
- Helps LLM understand tool's domain

### `description` (required)

The LLM reads this to decide when to use your tool. A good description answers three questions:

1. **What does it do?** Be specific about the action and target
2. **What does it return?** Mention key fields in the response
3. **When to use it?** Differentiate from other tools, especially generic ones

**Best practices:**

- For site-specific tools, add "Always prefer this over generic page tools for [site]"
- Mention key return values (e.g., "with timestamps", "with author names")
- Keep under 300 characters - LLMs process many tool descriptions

**Good examples:**

```
"Fetch Slack conversation from the current channel, DM, or thread. Returns messages with author names, timestamps, reactions, and nested thread replies. Always prefer this over generic page tools for Slack context."

"Query specific DOM elements using CSS selectors. Returns element metadata (tag, class, visibility, bounds) for each match. Use extractText/extractHtml params for content."
```

**Bad:** "Gets app data" (vague, no return info, no guidance)

### `match` (required)

URL patterns where the tool should be available:

```javascript
// Single pattern (string)
match: 'https://app.example.com/*';

// Multiple patterns (array)
match: ['*://www.example.com/view*', '*://example.com/view*'];

// All URLs (use sparingly)
match: ['<all_urls>'];
```

Pattern syntax:

- `*` matches any characters
- `://` separates scheme from host
- Use specific patterns to avoid injecting tools where they don't apply

### `inputSchema` (required)

JSON Schema defining tool arguments:

```javascript
inputSchema: {
  type: "object",
  properties: {
    limit: {
      type: "number",
      description: "Maximum items to fetch.",
      default: 100
    },
    format: {
      type: "string",
      enum: ["full", "summary"],
      description: "Output format. Default: full"
    },
    includeMetadata: {
      type: "boolean",
      description: "Include extra metadata in response"
    }
  },
  required: ["selector"],  // List required fields
  additionalProperties: false
}
```

If no arguments needed:

```javascript
inputSchema: {
  type: "object",
  properties: {},
  additionalProperties: false
}
```

## The `execute` Function

Per the WebMCP spec, execute receives two arguments:

- `args` - The tool arguments from the LLM
- `agent` - An agent context object with `requestUserInteraction()` for user confirmation flows

```javascript
export async function execute(args = {}, agent) {
  // Destructure with defaults
  const { limit = 100, format = 'full' } = args;

  // Tool logic here...

  // Return result
  return { ... };
}
```

### Requesting User Interaction

For tools that perform sensitive actions (purchases, deletions, etc.), use `agent.requestUserInteraction()`:

```javascript
export async function execute(args = {}, agent) {
  const { productId } = args;

  // Request user confirmation before sensitive action
  const confirmed = await agent.requestUserInteraction(async () => {
    return confirm(`Purchase product ${productId}?\nClick OK to confirm.`);
  });

  if (!confirmed) {
    throw new Error('Purchase cancelled by user.');
  }

  // Proceed with action...
  await executePurchase(productId);
  return { success: true, productId };
}
```

The `requestUserInteraction` API:

- Takes an async function that performs the UI interaction
- Returns the result of that function
- Allows tools to prompt for confirmation, input, or any other user interaction
- The agent (browser) handles pausing execution while waiting for user input

### Available in `execute`:

- Full DOM access: `document`, `window`
- Current URL: `window.location`
- Fetch API: `fetch()` (with page's cookies/auth)
- localStorage/sessionStorage
- Any page globals the site exposes

### Return Formats

**Simple object (most common):**

```javascript
return {
  title: document.title,
  url: window.location.href,
  content: extractedContent,
};
```

**MCP content format (for structured responses):**

```javascript
return {
  content: [{ type: 'text', text: markdownContent }],
  metadata: {
    id: resourceId,
    length: content.length,
  },
};
```

**JSON content:**

```javascript
return {
  content: [
    { type: 'json', json: { items: [...] } }
  ]
};
```

### Error Handling

Throw errors with descriptive messages:

```javascript
if (!resourceId) {
  throw new Error('Could not determine resource ID. Are you on the correct page?');
}

if (!response.ok) {
  throw new Error(`API request failed: ${response.status} ${response.statusText}`);
}
```

## Common Patterns

### 1. Extract ID from URL

```javascript
// Path-based ID
function getResourceId() {
  const match = window.location.href.match(/\/resource\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

// Query parameter
function getItemId() {
  return new URL(window.location.href).searchParams.get('id');
}

// Path segment
function getWorkspaceId() {
  return window.location.pathname.split('/')[2];
}
```

### 2. Fetch with Page Auth

Most sites have internal APIs you can call with the page's cookies:

```javascript
// Simple GET - cookies sent automatically
const response = await fetch(`https://example.com/api/data`);

// With credentials explicitly (usually not needed for same-origin)
const response = await fetch(url, { credentials: 'include' });

// POST with JSON body
const response = await fetch(`https://api.example.com/graphql`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: '...' }),
  credentials: 'include',
});

// POST with form data
const formData = new FormData();
formData.append('token', token);
formData.append('resource_id', resourceId);

const response = await fetch(`https://${window.location.host}/api/endpoint`, {
  method: 'POST',
  body: formData,
  credentials: 'include',
});
```

**CORS gotcha:** If the API redirects to a different domain that returns `Access-Control-Allow-Origin: *`, you CANNOT use `credentials: 'include'`. Omit it:

```javascript
// Export endpoints often redirect to CDN with permissive CORS
const response = await fetch(
  `https://example.com/export?format=md`
  // No credentials option - would conflict with ACAO: *
);
```

### 3. Extract Auth Tokens from Page

Sites often store tokens in localStorage or embed them in the page:

```javascript
// From localStorage
const config = JSON.parse(localStorage.getItem('app_config'));
const token = config.auth.token;

// From page HTML via regex
const html = document.documentElement.outerHTML;
const tokenMatch = html.match(/"API_TOKEN":"([^"]+)"/);
const apiToken = tokenMatch?.[1];

// From window globals
const data = window.__INITIAL_STATE__;
const sessionToken = data?.user?.sessionToken;
```

### 4. DOM-based Context Detection

When URLs don't reliably reflect app state (SPAs), inspect the DOM:

```javascript
function getCurrentContext() {
  let contextId = null;

  // Try URL first
  const path = window.location.pathname.split('/');
  const contextIndex = path.indexOf('context');
  if (contextIndex !== -1) {
    contextId = path[contextIndex + 1];
  }

  // Fallback: inspect DOM elements with data attributes
  if (!contextId) {
    const activeElement = document.querySelector('[data-active="true"]');
    if (activeElement?.dataset.contextId) {
      contextId = activeElement.dataset.contextId;
    }
  }

  // Fallback: parse from element ID or class
  if (!contextId) {
    const panel = document.querySelector('.context-panel[id^="context-"]');
    if (panel) {
      contextId = panel.id.replace('context-', '');
    }
  }

  return { contextId };
}
```

### 5. Parallel API Calls

When fetching multiple resources, parallelize:

```javascript
// Fetch all items in parallel
const itemPromises = itemIds.map(
  (id) => fetchApi(`/items/${id}`).catch((e) => null) // Don't fail entire operation if one item fails
);
const results = await Promise.all(itemPromises);

// Filter out failures
const items = results.filter(Boolean);
```

### 6. Build Entity Maps (ID to Name Resolution)

When API returns IDs, resolve them to human-readable names:

```javascript
function buildUserMap(items) {
  const userMap = new Map();
  for (const item of items) {
    if (item.userId && item.userProfile && !userMap.has(item.userId)) {
      userMap.set(item.userId, item.userProfile.displayName);
    }
  }
  return userMap;
}

// Fetch missing users not found in initial data
const missingUserIds = [
  ...new Set(items.filter((i) => i.userId && !userMap.has(i.userId)).map((i) => i.userId)),
];

if (missingUserIds.length > 0) {
  const userPromises = missingUserIds.map(
    (userId) =>
      fetchApi(`/users/${userId}`)
        .then((data) => userMap.set(userId, data.displayName))
        .catch(() => {}) // Silently fail, will use raw ID
  );
  await Promise.all(userPromises);
}
```

### 7. Prefer JSON over XML

When APIs offer format options, use JSON to avoid parsing issues:

```javascript
// Many APIs support format parameters
const jsonUrl = baseUrl + '&format=json';
const data = await (await fetch(jsonUrl)).json();

// Or mime type parameters
const response = await fetch(`${baseUrl}?mimeType=application/json`);
```

**Why avoid XML:** Parsing XML with `DOMParser` can trigger Trusted Types CSP violations on some sites. JSON parsing is native and CSP-safe.

## Gotchas & Lessons Learned

### Stale Data in Page Globals

Page globals (like `window.__INITIAL_DATA__`) are set at page load. If they contain signed URLs with expiry timestamps or session-specific tokens, they may be stale by the time your tool runs. Fetch fresh data via API when possible.

### Trusted Types CSP

Some sites have strict CSP that blocks:

- `DOMParser.parseFromString()`
- `element.innerHTML = ...` assignments

Solutions:

- Request JSON format instead of XML/HTML
- Use regex parsing as fallback for simple structures
- Avoid innerHTML for untrusted content

### API Response Differences

Different API endpoints may return different data shapes. For example:

- List endpoints may include embedded user profiles
- Detail endpoints may only return user IDs

Always verify what each endpoint returns before assuming field availability.

### CORS + Credentials Conflict

If an API redirects to a CDN with `Access-Control-Allow-Origin: *`, you cannot send credentials. The browser blocks it. Remove `credentials: 'include'` for such requests.

### SPA Navigation

Single-page apps may not update `window.location` when navigating. Your tool may need to:

- Detect context from DOM state, not just URL
- Handle cases where URL shows one view but DOM shows another

## Programmatic Tool Registration

For advanced use cases (like dynamically discovering tools), you can register tools programmatically:

```javascript
// Per WebMCP spec: navigator.modelContext is the primary API
// window.agent is also available as a backward-compatible alias

if ('modelContext' in navigator) {
  // Register a single tool
  navigator.modelContext.registerTool({
    name: 'my_tool',
    description: 'Does something useful',
    inputSchema: { type: 'object', properties: {} },
    execute: async (args, agent) => {
      return { result: 'success' };
    }
  });

  // Unregister a tool
  navigator.modelContext.unregisterTool('my_tool');

  // Clear all tools
  navigator.modelContext.clearContext();

  // Replace all tools at once
  navigator.modelContext.provideContext({
    tools: [
      { name: 'tool1', description: '...', inputSchema: {...}, execute: async (args, agent) => {...} },
      { name: 'tool2', description: '...', inputSchema: {...}, execute: async (args, agent) => {...} }
    ]
  });
}
```

**API methods:**

- `provideContext({ tools })` - Replace entire tool set (clears existing)
- `registerTool(tool)` - Add/replace a single tool
- `unregisterTool(name)` - Remove a tool by name
- `clearContext()` - Remove all tools
- `listTools()` - Get current tool definitions (without execute functions)
- `callTool(name, args)` - Invoke a tool (used by the agent, not typically by tools)

## Testing Your Tool

1. Open browser DevTools console on the target site
2. Paste your tool code and run `execute({})` manually
3. Check for:
   - Correct data extraction
   - API responses contain expected fields
   - Error handling for edge cases
   - CSP/CORS issues in console

4. Test edge cases:
   - Missing data (empty states, no content)
   - Auth expired/missing
   - Different page states (modal open, different views)

## Example: Minimal Tool

```javascript
'use webmcp-tool v1';

export const metadata = {
  name: 'document_content',
  namespace: 'myapp',
  version: '1.0.0',
  description: 'Extract the current document content as markdown.',
  match: 'https://app.example.com/doc/*',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
};

// agent param is optional if not using requestUserInteraction
export async function execute(args = {}, agent) {
  const docId = getDocId();
  if (!docId) {
    throw new Error('Could not extract document ID from URL.');
  }

  const response = await fetch(`https://app.example.com/api/docs/${docId}/export?format=md`);

  if (!response.ok) {
    throw new Error(`Export failed: ${response.status}`);
  }

  const content = await response.text();

  return {
    content: [{ type: 'text', text: content }],
    metadata: { docId, length: content.length },
  };
}

function getDocId() {
  const match = window.location.href.match(/\/doc\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}
```

## Example: Tool with User Interaction

```javascript
'use webmcp-tool v1';

export const metadata = {
  name: 'delete_item',
  namespace: 'myapp',
  version: '1.0.0',
  description: 'Delete an item after user confirmation.',
  match: 'https://app.example.com/*',
  inputSchema: {
    type: 'object',
    properties: {
      itemId: { type: 'string', description: 'ID of item to delete' },
    },
    required: ['itemId'],
    additionalProperties: false,
  },
};

export async function execute(args = {}, agent) {
  const { itemId } = args;

  // Request user confirmation before destructive action
  const confirmed = await agent.requestUserInteraction(async () => {
    return confirm(`Are you sure you want to delete item ${itemId}?`);
  });

  if (!confirmed) {
    return { cancelled: true, message: 'Deletion cancelled by user.' };
  }

  const response = await fetch(`https://app.example.com/api/items/${itemId}`, {
    method: 'DELETE',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`Delete failed: ${response.status}`);
  }

  return { success: true, itemId };
}
```

## Example: Tool with API Calls and Entity Resolution

```javascript
'use webmcp-tool v1';

export const metadata = {
  name: 'thread_context',
  namespace: 'myapp',
  version: '1.0.0',
  description: 'Fetch messages from the current conversation thread with resolved user names.',
  match: 'https://app.example.com/*',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max messages to fetch', default: 50 },
    },
    additionalProperties: false,
  },
};

export async function execute(args = {}, agent) {
  const { limit = 50 } = args;

  const threadId = getThreadId();
  if (!threadId) {
    throw new Error('Could not determine thread ID.');
  }

  // Fetch messages
  const response = await fetch(
    `https://app.example.com/api/threads/${threadId}/messages?limit=${limit}`,
    { credentials: 'include' }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch messages: ${response.status}`);
  }

  const data = await response.json();
  const messages = data.messages || [];

  // Build user map from embedded profiles
  const userMap = new Map();
  for (const msg of messages) {
    if (msg.author?.id && msg.author?.name) {
      userMap.set(msg.author.id, msg.author.name);
    }
  }

  // Fetch any missing user profiles
  const missingIds = [
    ...new Set(
      messages.filter((m) => m.authorId && !userMap.has(m.authorId)).map((m) => m.authorId)
    ),
  ];

  if (missingIds.length > 0) {
    await Promise.all(
      missingIds.map((id) =>
        fetch(`https://app.example.com/api/users/${id}`, { credentials: 'include' })
          .then((r) => r.json())
          .then((u) => userMap.set(id, u.displayName))
          .catch(() => {})
      )
    );
  }

  // Format output
  const formatted = messages.map((msg) => ({
    author: userMap.get(msg.authorId) || msg.authorId,
    timestamp: msg.createdAt,
    content: msg.text,
  }));

  return {
    content: [{ type: 'json', json: { threadId, messages: formatted } }],
  };
}

function getThreadId() {
  // Try URL path
  const match = window.location.pathname.match(/\/thread\/([a-zA-Z0-9]+)/);
  if (match) return match[1];

  // Fallback: check DOM for active thread
  const activeThread = document.querySelector('[data-thread-id][data-active="true"]');
  return activeThread?.dataset.threadId || null;
}
```
