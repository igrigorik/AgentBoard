# AgentBoard

<img width="2800" height="838" alt="image" src="https://github.com/user-attachments/assets/2f520ecd-1601-4226-8254-7994be61bde0" />

A switchboard for AI in your browser: wire in any model, script WebMCP tools, connect remote MCP servers, bring your commands.

- **Multi agent**: Configure as many profile as you want, switch mid-conversation.
- **Your provider**: OpenAI, Anthropic, Google, or your own completion-compatible endpoint.
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
  │  │ TabManager                   │  │      │  │ MAIN: window.agent │  │
  │  │  - Script injection          │  │      │  │  - Tool execution  │  │
  │  │  - Lifecycle                 │  │      │  │  - Full DOM access │  │
  │  └──────────────────────────────┘  │      │  └────────────────────┘  │
  └────────────────────────────────────┘      └──────────────────────────┘
```

The AI sidebar is tab-scoped—each sidebar instance binds to one browser tab and sees tools from that tab's page context plus global tools (remote MCP servers and system capabilities). When you open the sidebar, the background service worker injects WebMCP scripts into the page: a polyfill that provides `window.agent`, a relay in the ISOLATED world, and a bridge in the MAIN world. Pages register tools via `window.agent.registerTool()`, triggering `tools/listChanged` events that flow through a persistent port connection from the relay to the background service worker. The ToolRegistry aggregates all discovered tools—WebMCP from pages, remote MCP from external servers, system tools from the extension—and converts them to AI SDK format for the AI Client.

When you send a message, the AI Client streams responses from your chosen provider (OpenAI, Anthropic, Google, or custom endpoint). Tool calls route based on type: WebMCP tools execute in the browser tab's MAIN world via JSON-RPC `callTool` commands (full DOM access, zero serialization overhead), remote MCP tools execute on your external servers with streaming HTTP, and system tools run in the service worker with elevated privileges (CORS-free fetching, for example).

---

## Agent Profiles

**Gemini with Extended Thinking:**

```javascript
{
  provider: "google",
  model: "gemini-2.0-flash-thinking-exp-01-21",
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

**Local Ollama:**

```javascript
{
  provider: "openai",
  endpoint: "http://localhost:11434/v1",
  model: "llama3.1:70b",
  apiKey: "ollama",  // Required but not used
  systemPrompt: "You are a coding assistant.",
  temperature: 0.7
}
```

Configure as many profiles as you want. Switch mid-conversation.

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
  description: 'Extract all prices from the current page',
  match: 'example.com',
};

export async function execute() {
  const prices = Array.from(document.querySelectorAll('[class*="price"]')).map((el) => ({
    text: el.textContent.trim(),
    value: el.dataset.price || el.getAttribute('content'),
  }));

  return { prices, count: prices.length };
}
```

Save in Settings → My Tools. AI can now call it when you prompt your agent to find prices when on example.com.

**Built-in WebMCP tools:**

- `agentboard_dom_query` - CSS selector extraction
- `agentboard_page_info` - Page metadata and OpenGraph
- `agentboard_fetch_url` - URL fetching with optional markdown conversion
- `agentboard_dom_readability` - Extracts readable content in Markdown format

## Commands

Fast interactions with expansion templates.

```bash
/explain how async/await works
→ "Explain $ARGUMENTS in simple terms with examples, use page context."

/tldr
→ "Summarize this page in 5 bullet points. Provide a short critique."
```

---

## Development

```bash
npm install       # Install dependencies
npm run dev       # Start with hot reload
npm run build     # Production build
npm test          # Run tests
npm run check     # Type check + lint + test
```

Load `dist/` folder in `chrome://extensions` (Developer Mode).

---

## FAQ

## What kind of MCP servers can I call?

Any MCP server that supports HTTP streaming. Add auth tokens if needed. Examples: internal APIs, databases, GitHub tools, company integrations. As long as the server speaks MCP over HTTP, it works. We do not support `stdio` MCP servers, but if you can host your stdio tools behind an streaming HTTP interface/proxy (e.g. via [MCProxy](https://github.com/igrigorik/mcproxy) or similar) then anything is possible.

## What kind of scripts can I write with WebMCP?

Any JavaScript that interacts with the page. Extract data with CSS selectors. Click buttons. Submit forms. Modify content. Access page JavaScript state. Read cookies. Trigger events. Use URL match patterns to scope tools to specific sites. Full DOM access, full page context. If you can do it in the browser console, you can script it as a WebMCP tool.

## How do site CSP policies and WebMCP interact?

Sites that deploy strict CSP (e.g. no dynamic scripts) may not allow custom tools to be executed — this is expected behavior. Built-in tools that ship with AgentBoard can execute in all context, but custom scripts are constrained by site's CSP policy.

## What information does AgentBoard collect?

None. See [PRIVACY.md](PRIVACY.md).
