'use webmcp-tool v1';

export const metadata = {
  name: 'shopify_bootstrap',
  namespace: 'agentboard',
  version: '1.0.0',
  description: 'Dynamically discovers and registers Shopify MCP tools for searching merchant catalog and managing cart.',
  match: ['<all_urls>']
};

export function shouldRegister() {
  // 1. Check if Shopify site
  if (typeof window.Shopify === 'undefined' || !window.Shopify.shop) {
    return false;
  }

  console.log('[Shopify Bootstrap] Detected Shopify store:', window.Shopify.shop);

  // 2. Check if already bootstrapped (prevent duplicates)
  if (window.__shopifyMCPBootstrapped) {
    return false;
  }

  // 3. Mark as bootstrapped immediately to prevent race conditions
  window.__shopifyMCPBootstrapped = true;

  // 4. Fire-and-forget async discovery
  discoverAndRegisterShopifyTools().catch(error => {
    console.error('[Shopify Bootstrap] Failed to discover tools:', error);
    // Reset flag on error to allow retry on next injection
    window.__shopifyMCPBootstrapped = false;
  });

  // 5. Don't register the bootstrap tool itself
  return false;
}

async function discoverAndRegisterShopifyTools() {
  const shopDomain = window.location.hostname;
  const mcpEndpoint = `${window.location.protocol}//${shopDomain}/api/mcp`;

  try {
    // Step 1: List available tools
    const listResponse = await fetch(mcpEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        id: Date.now(),
        params: {}
      })
    });

    console.log('[Shopify Bootstrap] MCP response status:', listResponse.status);

    if (!listResponse.ok) {
      throw new Error(`Failed to list tools: ${listResponse.status}`);
    }

    const listResult = await listResponse.json();
    console.log('[Shopify Bootstrap] Raw MCP response:', listResult);

    if (listResult.error) {
      throw new Error(listResult.error.message || 'Failed to list tools');
    }

    // Extract tools from response
    // Handle both direct array and MCP content format
    let tools = [];

    // Log the raw tools list structure
    console.log('[Shopify Bootstrap] Raw tools/list result structure:', {
      hasResult: !!listResult.result,
      resultType: typeof listResult.result,
      isArray: Array.isArray(listResult.result),
      hasTools: !!(listResult.result?.tools),
      hasContent: !!(listResult.result?.content)
    });

    if (Array.isArray(listResult.result)) {
      tools = listResult.result;
    } else if (listResult.result?.tools) {
      tools = listResult.result.tools;
    } else if (listResult.result?.content) {
      // Handle MCP content format with text-wrapped JSON
      const content = listResult.result.content;
      if (Array.isArray(content) && content[0]?.type === 'text') {
        try {
          const parsed = JSON.parse(content[0].text);
          tools = parsed.tools || parsed;
        } catch (e) {
          console.warn('[Shopify Bootstrap] Could not parse tools from content:', e);
        }
      }
    }

    if (!Array.isArray(tools) || tools.length === 0) {
      console.warn('[Shopify Bootstrap] No tools found in response');
      return;
    }

    console.log(`[Shopify Bootstrap] Discovered ${tools.length} tools:`, tools.map(t => t.name));

    // Log the actual schemas for debugging
    tools.forEach(tool => {
      console.log(`[Shopify Bootstrap] ${tool.name} raw schema:`, JSON.stringify(tool.inputSchema, null, 2));
    });

    // Step 2: Register each tool
    tools.forEach(tool => {
      try {
        registerShopifyTool(tool, mcpEndpoint);
      } catch (error) {
        console.error(`[Shopify Bootstrap] Failed to register tool ${tool.name}:`, error);
      }
    });

    console.log('[Shopify Bootstrap] Tool registration complete');

  } catch (error) {
    console.error('[Shopify Bootstrap] Discovery failed:', error);
    throw error;
  }
}

function registerShopifyTool(toolSchema, mcpEndpoint) {
  const toolName = `shopify_${toolSchema.name}`;

  console.log(`[Shopify Bootstrap] Registering tool: ${toolName}`, {
    originalName: toolSchema.name,
    description: toolSchema.description,
    hasInputSchema: !!toolSchema.inputSchema,
    inputSchema: toolSchema.inputSchema
  });

  // Build the tool object
  // For dynamically registered tools, use a permissive schema that doesn't validate
  // This is because Shopify's schema might not match what the LLM sends
  const tool = {
    name: toolName,
    description: toolSchema.description || `Shopify MCP tool: ${toolSchema.name}`,
    inputSchema: toolSchema.inputSchema || { type: 'object', properties: {} },

    // Create an execute function that proxies to MCP
    // Per WebMCP spec: execute receives (args, agent)
    execute: createExecutor(toolSchema.name, mcpEndpoint)
  };

  // Register with modelContext (per WebMCP spec)
  // Falls back to window.agent for backward compat
  const modelContext = ('modelContext' in navigator) ? navigator.modelContext : window.agent;
  
  if (modelContext && typeof modelContext.registerTool === 'function') {
    modelContext.registerTool(tool);
    console.log(`[Shopify Bootstrap] ✅ Successfully registered: ${toolName}`);
  } else {
    throw new Error('navigator.modelContext.registerTool not available');
  }
}

function createExecutor(originalToolName, mcpEndpoint) {
  return async function execute(args) {
    console.log(`[Shopify Bootstrap] Executing tool: ${originalToolName}`, args);

    // Build the request payload
    const requestPayload = {
      jsonrpc: '2.0',
      method: 'tools/call',
      id: Date.now(),
      params: {
        name: originalToolName,
        arguments: args
      }
    };

    console.log(`[Shopify Bootstrap] Sending MCP request:`, requestPayload);

    try {
      const response = await fetch(mcpEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(requestPayload)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();

      // Handle JSON-RPC errors
      if (result.error) {
        console.error(`[Shopify Bootstrap] MCP error for ${originalToolName}:`, result.error);
        throw new Error(result.error.message || `MCP Error ${result.error.code}`);
      }

      // Handle Shopify's text-wrapped JSON quirk
      if (result.result && typeof result.result === 'object' && 'content' in result.result) {
        const content = result.result.content;
        if (Array.isArray(content) && content.length > 0) {
          // Transform text-wrapped JSON to proper JSON
          const transformedContent = content.map(item => {
            if (item.type === 'text' && typeof item.text === 'string') {
              try {
                // Parse the stringified JSON
                const parsed = JSON.parse(item.text);
                return { type: 'json', json: parsed };
              } catch {
                // If parsing fails, keep as text
                return item;
              }
            }
            // Pass through non-text items unchanged
            return item;
          });

          console.log(`[Shopify Bootstrap] Transformed text-wrapped JSON for ${originalToolName}`);
          return { content: transformedContent };
        }
      }

      // Fallback: return as-is if structure is unexpected
      console.log(`[Shopify Bootstrap] Returning raw response for ${originalToolName}`);
      return result.result;

    } catch (error) {
      // Distinguish between network errors and API errors
      const isNetworkError = error.message.includes('Failed to fetch') ||
        error.message.includes('NetworkError');

      return {
        content: [{
          type: 'text',
          text: isNetworkError
            ? `Network error: Could not reach Shopify MCP endpoint at ${mcpEndpoint}`
            : `Shopify MCP Error: ${error.message}`
        }]
      };
    }
  };
}

// We need a dummy execute function even though shouldRegister returns false
export async function execute() {
  return {
    content: [{
      type: 'text',
      text: 'Bootstrap tool should not be directly executed'
    }]
  };
}
