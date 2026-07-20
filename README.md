# AgentBoard

<img width="2800" height="838" alt="image" src="https://github.com/user-attachments/assets/2f520ecd-1601-4226-8254-7994be61bde0" />

A switchboard for AI in your browser: wire in any model, script WebMCP tools, connect remote MCP servers, bring your commands.

- **Multi agent**: Configure as many profiles as you want and switch mid-conversation.
- **Your connection**: OpenAI-style Responses or legacy Chat Completions, Anthropic Messages, Google Generative AI, or a compatible proxy endpoint.
- **Your settings**: System prompts, temperature, thinking settings.
- **Your keys**: Bring your own API keys. No lock-in, no upselling.
- **Your tools**: Script WebMCP tools for page interactions. Connect remote MCP servers.
- **Your commands**: Template prompts with arguments; type `/analyze`, not paragraphs.

Bring your own models—local, fine-tuned, custom—to power multiple agent profiles. Connect remote MCP servers: bring external tools (APIs, databases, services) into browser context. Script WebMCP tools that interact with page content — think, Greasemonkey for the AI age. Built for power users.

## Install extension from [Chrome Web Store](https://chromewebstore.google.com/detail/agentboard/jlmajjfiibgnejlndfoboojahlclgoam?authuser=0&hl=en)

[<img width="976" height="562" alt="image" src="https://github.com/user-attachments/assets/69ee32a1-67b2-45b6-8b6b-f0c6fc266a5f" />](https://www.youtube.com/watch?v=Sf9M5SeInOU)

---

## Architecture overview

```
  ┌────────────────────────────────────┐
  │  === Tab-Scoped AI Sidebar ===     │
  │  - Markdown rendering              │
  │  - Tool visualization              │
  │  - Reasoning display               │
  └────────────┬───────────────────────┘
               │ Port (streaming)
  ┌────────────▼───────────────────────┐
  │  Background Service Worker         │
  │  ┌──────────────────────────────┐  │
  │  │ AI Client                    │  │
  │  │  - Multi-provider            │  │      ┌──────────────────────────┐
  │  │  - Streaming + tools         │  │      │      Browser Tab         │
  │  └──────────────────────────────┘  │      │  ┌────────────────────┐  │
  │  ┌──────────────────────────────┐  │      │  │ ISOLATED: Relay    │  │
  │  │ ToolRegistry                 │  │◄─────┤  │  - Forwarding      │  │
  │  │  - WebMCP + Remote + System  │  │ Port │  └────────┬───────────┘  │
  │  └──────────────────────────────┘  │      │           │              │
  │  ┌──────────────────────────────┐  │      │  ┌────────▼───────────┐  │
  │  │ TabManager                   │  │      │  │ MAIN: modelContext │  │
  │  │  - Script injection          │  │      │  │  - Tool execution  │  │
  │  │  - Lifecycle                 │  │      │  │  - Full DOM access │  │
  │  └──────────────────────────────┘  │      │  └────────────────────┘  │
  └────────────────────────────────────┘      └──────────────────────────┘
```

The AI sidebar is tab-scoped—each sidebar instance binds to one browser tab and sees tools from that tab's page context plus global tools (remote MCP servers and system capabilities). At document start, AgentBoard preserves Chromium's native `document.modelContext` when available or installs a standards-shaped polyfill otherwise. Pages and injected AgentBoard scripts register tools through `document.modelContext.registerTool()`. A MAIN-world bridge publishes clone-safe tool descriptors through the ISOLATED-world relay and persistent port to the background service worker. The ToolRegistry combines tab-owned WebMCP tools with remote MCP and system capabilities, then converts them to AI SDK format for the AI Client.

When you send a message, the AI Client uses the agent's explicit Connection API and streams from its direct or proxy endpoint. The descriptive provider label does not select the wire protocol. WebMCP calls route back to the owning browser tab, where the MAIN-world bridge invokes the exact browser descriptor through `document.modelContext.executeTool()`. Remote MCP tools execute on external servers with streaming HTTP, while system tools run in the service worker with elevated privileges such as CORS-free fetching.

---

## Agent Profiles

Every agent has an explicit Connection API. AgentBoard never guesses a protocol from the provider, model, or endpoint at request time and never retries a failed request through another protocol.

| Settings choice            | `apiProtocol`             | Wire contract                                                                                  |
| -------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------- |
| OpenAI-style · Responses   | `openai-responses`        | OpenAI Responses API; new OpenAI-style agents default here and requests include `store: false` |
| OpenAI-style · Legacy Chat | `openai-chat-completions` | OpenAI Chat Completions API for compatible providers and proxies                               |
| Anthropic                  | `anthropic-messages`      | Anthropic Messages API                                                                         |
| Google                     | `google-generative-ai`    | Google Generative AI API                                                                       |

Choose the contract implemented by the endpoint, not the company that produced the model. For example, a Gemini model served by an OpenAI-compatible proxy uses an OpenAI-style Connection API. A custom endpoint must implement the selected contract, including its authentication and streaming format; when its API key is left blank, AgentBoard omits provider authentication headers. Existing or imported proxy-routed agents can retain descriptive `provider` metadata that differs from the Connection API, while newly created agents derive that metadata from the selected API.

**Google with thinking:**

```javascript
{
  provider: "google",
  apiProtocol: "google-generative-ai",
  model: "your-google-model",
  apiKey: "your-api-key",
  systemPrompt: "You are a helpful assistant.",
  reasoning: {
    enabled: true,
    google: {
      thinkingBudget: 8192,
      includeThoughts: true
    }
  }
}
```

**Local Ollama using legacy Chat Completions:**

```javascript
{
  provider: "openai",
  apiProtocol: "openai-chat-completions",
  endpoint: "http://localhost:11434/v1",
  model: "llama3.1:70b",
  systemPrompt: "You are a coding assistant.",
  temperature: 0.7
}
```

Configure as many profiles as you want. Switch mid-conversation. Current settings and exports use schema v2 with required `schemaVersion: 2` and per-agent `apiProtocol`. Released v1 settings and v1 backups are migrated once; a v1 backup envelope containing already-migrated v2 settings after a rollback is also accepted. Older releases ignore `apiProtocol` and may infer a different transport, so a safe rollback that preserves routing requires a pre-migration export or an explicit reverse migration.

## MCP tools

Bring custom external tools to give your agent superpowers. AgentBoard supports remote MCP servers (must support HTTP streaming), and WebMCP-exposed tools. Better, it allows you to author and inject own WebMCP tools to script custom workflows that your agent can call to complete tasks on your behalf.

### Remote MCP Servers

The agent can call any remote MCP server, as long as it supports HTTP streaming. Bring your MCP config and agent will do the rest to discover and expose available tools. Run `/tools` in chat to audit available capabilities.

```json
{
  "mcpServers": {
    "github": {
      "url": "https://your-mcp-server.com/mcp",
      "transport": "http"
    },
    "company-tools": {
      "url": "https://internal.example.com/mcp",
      "transport": "http",
      "authToken": "your-bearer-token"
    }
  }
}
```

### WebMCP Scripts

[WebMCP](https://github.com/webmachinelearning/webmcp) is a mechanism for sites to expose tools, which are JavaScript functions with structured schema, that browser AI agents can call to interact with the site. AgentBoard polyfills and extends WebMCP, allowing you to author custom scripts that can be executed in context of the page. For those that remember: like Greasemonkey, but AI-controlled! Example script...

```javascript
'use webmcp-tool v1';

export const metadata = {
  name: 'extract_prices',
  description:
    'Extract product prices from the current page. Returns price text and structured value for each element. Use for price comparison, deal finding, or cart analysis.',
  match: '*://example.com/*',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
};

export async function execute() {
  const prices = Array.from(document.querySelectorAll('[class*="price"]')).map((el) => ({
    text: el.textContent.trim(),
    value: el.dataset.price || el.getAttribute('content'),
  }));

  return { prices, count: prices.length };
}
```

Save in Settings → My Tools. The AI can now call it when you ask about prices on example.com. See [examples/](examples/) for more complete tool implementations.

**Built-in WebMCP tools:**

- `agentboard_read_page` - Read the rendered page as article markdown, visible application text, or metadata context
- `agentboard_youtube_transcript` - Video transcript extraction with timestamps (YouTube only)
- `agentboard_fetch_url` - Fetch external URLs with optional markdown conversion

## Commands

Fast interactions with expansion templates.

```bash
/explain how async/await works
→ "Explain $ARGUMENTS in simple terms with examples, use page context."

/tldr
→ "Summarize this page in 5 bullet points. Provide a short critique."
```

---

## Privacy and data flow

AgentBoard has no operated telemetry or AI proxy, but configured features are not local-only. When you send a chat, the AI endpoint receives the conversation plus the attached tab's full URL and title; URLs may contain sensitive paths, query parameters, fragments, document identifiers, or tokens. AI endpoints can also receive attachments, tool definitions, tool arguments, and tool results. Remote MCP servers receive MCP protocol traffic and authorization tokens. Credential-free URL fetches contact the requested website. The built-in YouTube transcript tool contacts YouTube Innertube and caption endpoints; its same-origin Innertube request and explicit caption request can include browser YouTube/Google session credentials. User WebMCP scripts run with page-level capabilities defined by their source.

Settings are stored in `chrome.storage.local`. Conversation traffic is kept in memory rather than extension storage, and extension diagnostics discard caller-supplied values before reaching browser consoles. Settings exports are plaintext and can contain AI credentials, MCP tokens, endpoint URLs, system prompts, and executable user scripts; treat every backup as a secret.

OpenAI Responses requests include `store: false`, but that does not guarantee Zero Data Retention or disable provider/proxy logging, abuse monitoring, retention, or prompt caching. See [PRIVACY.md](PRIVACY.md) for the complete boundary and deletion guidance.

---

## Development

```bash
pnpm install      # Install dependencies
pnpm run dev      # Start with hot reload
pnpm run build    # Production build
pnpm test         # Run tests
pnpm run check    # Type check + lint + test
```

Load `dist/` folder in `chrome://extensions` (Developer Mode). Chromium derives an unpacked extension's identity from its absolute path, so loading `dist/` from a different checkout creates a separate installation with separate `chrome.storage.local` settings. Rebuild and reload the same unpacked path when testing an upgrade, or use an export to move settings between installations.

---

## FAQ

## What kind of MCP servers can I call?

Any MCP server that supports HTTP streaming. Add auth tokens if needed. Examples: internal APIs, databases, GitHub tools, company integrations. As long as the server speaks MCP over HTTP, it works. We do not support `stdio` MCP servers, but if you can host your stdio tools behind an streaming HTTP interface/proxy (e.g. via [MCProxy](https://github.com/igrigorik/mcproxy) or similar) then anything is possible.

## What kind of scripts can I write with WebMCP?

Any JavaScript that interacts with the page. Extract data with CSS selectors. Click buttons. Submit forms. Modify content. Access page JavaScript state. Read cookies. Trigger events. Use URL match patterns to scope tools to specific sites. Full DOM access, full page context. If you can do it in the browser console, you can script it as a WebMCP tool.

## How do site CSP policies and WebMCP interact?

Sites that deploy strict CSP (e.g. no dynamic scripts) may not allow custom tools to be executed — this is expected behavior. Built-in tools that ship with AgentBoard can execute in all context, but custom scripts are constrained by site's CSP policy.

## What information does AgentBoard collect?

AgentBoard does not send telemetry to an AgentBoard-operated service. It stores your settings locally and sends request data to the AI, MCP, and website endpoints you configure or invoke. See [PRIVACY.md](PRIVACY.md) for the exact data boundaries.
