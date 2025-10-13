# Shopify MCP Bootstrap Tool

## Overview

A dynamic tool discovery and registration system for Shopify MCP endpoints. This tool automatically discovers available tools on Shopify sites and registers them with the agent, eliminating the need to manually maintain individual tool implementations.

## How It Works

### 1. Detection Phase (Synchronous)

- Checks if the current site is a Shopify store via `window.Shopify.shop`
- Verifies bootstrap hasn't already run (prevents duplicates)
- Returns `false` from `shouldRegister()` - the bootstrap tool itself never registers

### 2. Discovery Phase (Asynchronous)

- Queries `/api/mcp` with `tools/list` method to get available tools
- Handles multiple response formats from Shopify
- Parses text-wrapped JSON (Shopify's quirk)

### 3. Registration Phase (Asynchronous)

- For each discovered tool:
  - Creates a namespaced tool name (`shopify_` prefix)
  - Builds an execute function that proxies to MCP
  - Registers with `window.agent.registerTool()`

## Key Features

### Zero Maintenance

- Automatically adapts when Shopify adds, removes, or modifies tools
- No code changes needed for schema updates
- Future-proof against API changes

### Fire-and-Forget Pattern

- Async discovery doesn't block page load
- Tools appear within milliseconds
- No impact on page performance

### Transparent Proxy

- Each tool's execute function proxies directly to Shopify's MCP
- Preserves original tool names for MCP calls
- Handles response format transformation

### Automatic JSON Transformation

- Detects Shopify's text-wrapped JSON responses
- Converts to proper JSON format for better LLM consumption
- Graceful fallback if parsing fails

## Technical Details

### Global State

- `window.__shopifyMCPBootstrapped`: Prevents duplicate bootstrapping

### Tool Naming

- Original tool: `search_shop_catalog`
- Registered as: `shopify_search_shop_catalog`

### Error Handling

- Graceful failures at each stage
- Detailed console logging for debugging
- Bootstrap flag resets on error to allow retry

## Example Flow

1. User visits `example-store.myshopify.com`
2. Bootstrap detects Shopify via `window.Shopify`
3. Queries `/api/mcp` for available tools
4. Receives list: `search_shop_catalog`, `get_cart`, `update_cart`, etc.
5. Registers each tool with prefixed names
6. Agent can now use `shopify_search_shop_catalog`, `shopify_get_cart`, etc.

## Response Format

Each dynamically registered tool:

- Accepts the same parameters as the original Shopify tool
- Returns MCP content blocks with proper JSON formatting
- Handles errors consistently

## Advantages Over Static Implementation

| Static Approach               | Bootstrap Approach        |
| ----------------------------- | ------------------------- |
| Manually maintain each tool   | Auto-discovers all tools  |
| Update code when tools change | Zero maintenance          |
| Schema mismatches possible    | Always uses latest schema |
| Multiple files to manage      | Single bootstrap file     |
| Fixed tool set                | Adapts to available tools |

## Debugging

Enable console to see bootstrap progress:

```
[Shopify Bootstrap] Discovered 4 tools
[Shopify Bootstrap] Registered tool: shopify_search_shop_catalog
[Shopify Bootstrap] Registered tool: shopify_search_shop_policies_and_faqs
[Shopify Bootstrap] Registered tool: shopify_get_cart
[Shopify Bootstrap] Registered tool: shopify_update_cart
[Shopify Bootstrap] Tool registration complete
```

## Limitations

- Tools are not available immediately on page load (millisecond delay)
- Requires Shopify MCP endpoint to be accessible
- No tool filtering (registers all discovered tools)

## Future Enhancements

- Support for other MCP-enabled platforms
- Tool filtering/allowlist configuration
- Refresh mechanism for long-lived pages
- Progress notifications to agent
