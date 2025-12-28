# Shopify Storefront Tools

Example WebMCP user script that auto-discovers and registers tools from Shopify's MCP endpoint.

## Installation

Copy `shopify_storefront.js` into your AgentBoard user scripts (Options → User Scripts → Add).

## How It Works

1. **Detection**: Checks for `window.Shopify.shop` to identify Shopify stores
2. **Discovery**: Queries `/api/mcp` with `tools/list` to enumerate available tools
3. **Registration**: Registers each tool with `shopify_` prefix via `window.agent.registerTool()`

The bootstrap tool itself never registers (`shouldRegister()` returns false) — it only discovers and registers the merchant's available tools.

## Why Bootstrap?

| Static Approach                 | Bootstrap Approach         |
| ------------------------------- | -------------------------- |
| Manually maintain each tool     | Auto-discovers all tools   |
| Update code when schemas change | Zero maintenance           |
| Fixed tool set                  | Adapts to merchant's tools |

## Tool Naming

- Original: `search_shop_catalog`
- Registered as: `shopify_search_shop_catalog`

## Response Handling

Shopify wraps JSON responses in text content blocks. The bootstrap tool automatically transforms these to proper JSON for better LLM consumption.

## Debugging

Console output shows discovery progress:

```
[Shopify Bootstrap] Detected Shopify store: example-store.myshopify.com
[Shopify Bootstrap] Discovered 4 tools: search_shop_catalog, get_cart, ...
[Shopify Bootstrap] Tool registration complete
```

## Limitations

- Small delay before tools are available (async discovery)
- Requires Shopify MCP endpoint to be accessible
- Registers all discovered tools (no filtering)
