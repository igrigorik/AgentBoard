/**
 * WebMCP Page Bridge (MAIN World)
 * Bridges navigator.modelContext events to the extension via postMessage
 * Executes in MAIN world with full access to page runtime
 *
 * Aligns with WebMCP proposed spec:
 * https://github.com/webmachinelearning/webmcp/blob/main/docs/proposal.md
 */
(function () {
  'use strict';

  // Guard against double injection
  if (window.__webmcpPageBridge) return;
  window.__webmcpPageBridge = true;

  const JSONRPC = '2.0';
  const BRIDGE_ID = 'webmcp-main';

  /**
   * Post a message to the content script
   */
  function postToExtension(message) {
    window.postMessage({
      source: BRIDGE_ID,
      ...message
    }, '*');
  }

  /**
   * Get the agent-side API for discovering and executing tools
   * 
   * Chrome's WebMCP implementation:
   * - navigator.modelContextTesting = agent-side (listTools, executeTool, registerToolsChangedCallback)
   * - navigator.modelContext = page-side (registerTool, unregisterTool, provideContext)
   * 
   * Our polyfill provides the same separation.
   */
  function getAgentAPI() {
    // Use modelContextTesting (agent-side API) - either native Chrome or our polyfill
    if ('modelContextTesting' in navigator) {
      return {
        native: !Object.prototype.hasOwnProperty.call(navigator.modelContextTesting, 'errors'), // Native won't have our errors property
        listTools: () => navigator.modelContextTesting.listTools(),
        // executeTool expects args as JSON string
        executeTool: (name, args) => navigator.modelContextTesting.executeTool(name, JSON.stringify(args)),
        registerToolsChangedCallback: (callback) => navigator.modelContextTesting.registerToolsChangedCallback(callback)
      };
    }
    // Legacy fallback: window.agent (backward compat API)
    if ('agent' in window) {
      return {
        native: false,
        listTools: () => window.agent.listTools(),
        executeTool: (name, args) => window.agent.callTool(name, args),
        registerToolsChangedCallback: (callback) => window.agent.addEventListener('tools/listChanged', callback)
      };
    }
    return null;
  }

  /**
   * Initialize bridge using the agent-side API
   */
  function initBridge() {
    const agentAPI = getAgentAPI();

    if (!agentAPI) {
      console.warn('[WebMCP Bridge] No WebMCP API found (modelContextTesting, modelContext, or agent)');
      return;
    }

    console.log('[WebMCP Bridge] Initializing in MAIN world', agentAPI.native ? '(native Chrome API)' : '(polyfill)');

    // Get current tools immediately - in case any were registered before we got here
    const currentTools = agentAPI.listTools();
    console.log('[WebMCP Bridge] Current tools on init:', currentTools);

    // Send initial snapshot if there are already tools
    if (currentTools.length > 0) {
      postToExtension({
        jsonrpc: JSONRPC,
        method: 'tools/listChanged',
        params: {
          tools: currentTools,
          origin: location.origin,
          timestamp: Date.now(),
          initial: true
        }
      });
      console.log('[WebMCP Bridge] Sent initial snapshot with', currentTools.length, 'existing tools');
    }

    // Subscribe to tool registry changes
    agentAPI.registerToolsChangedCallback(() => {
      try {
        const tools = agentAPI.listTools();
        postToExtension({
          jsonrpc: JSONRPC,
          method: 'tools/listChanged',
          params: {
            tools,
            origin: location.origin,
            timestamp: Date.now()
          }
        });
        console.log('[WebMCP Bridge] Forwarded tools/listChanged', tools.length, 'tools');
      } catch (err) {
        console.error('[WebMCP Bridge] Failed to forward tools/listChanged:', err);
      }
    });

    // Listen for requests from extension
    window.addEventListener('message', async (event) => {
      // Only accept messages from same window
      if (event.source !== window) return;

      // Check for our protocol
      if (!event.data || event.data.source !== 'webmcp-bridge') return;
      if (event.data.jsonrpc !== JSONRPC) return;

      const msg = event.data;

      // Only handle requests with an ID (not notifications)
      if (!msg.id) return;

      // Handle tools/list request (for service worker wake-up scenarios)
      if (msg.method === 'tools/list') {
        console.log('[WebMCP Bridge] Received tools/list request');

        try {
          const tools = agentAPI.listTools();

          // Send tools via notification (not a response to preserve protocol semantics)
          postToExtension({
            jsonrpc: JSONRPC,
            method: 'tools/listChanged',
            params: {
              tools,
              origin: location.origin,
              timestamp: Date.now(),
              requested: true // Flag to indicate this was explicitly requested
            }
          });

          console.log('[WebMCP Bridge] Sent tools list:', tools.length, 'tools');
        } catch (error) {
          console.error('[WebMCP Bridge] Failed to list tools:', error);
          // Send error response
          postToExtension({
            jsonrpc: JSONRPC,
            id: msg.id,
            error: {
              code: -32603,
              message: error?.message || 'Failed to list tools'
            }
          });
        }
        return;
      }

      // Handle tools/call request
      if (msg.method === 'tools/call') {
        console.log('[WebMCP Bridge] Received tool call request:', msg.params?.name);

        const { name, arguments: args } = msg.params || {};

        try {
          // Delegate to agent API
          const result = await agentAPI.executeTool(name, args || {});

          // Send success response
          postToExtension({
            jsonrpc: JSONRPC,
            id: msg.id,
            result
          });

          console.log('[WebMCP Bridge] Tool call succeeded:', name);
        } catch (error) {
          // Send error response
          const errorResponse = {
            jsonrpc: JSONRPC,
            id: msg.id,
            error: {
              code: -32000,
              message: error?.message || String(error),
              data: {
                name: error?.name,
                toolName: error?.toolName
              }
            }
          };

          postToExtension(errorResponse);

          console.error('[WebMCP Bridge] Tool call failed:', name, error);
        }
        return;
      }
    });

    console.log('[WebMCP Bridge] Ready and listening');
  }

  // Initialize immediately if any WebMCP API exists
  const agentAPI = getAgentAPI();
  if (agentAPI) {
    initBridge();
  } else {
    // If no API exists yet, it might be loaded later
    // This shouldn't happen if polyfill is injected at document_start
    console.warn('[WebMCP Bridge] No WebMCP API found at injection time');
  }
})();
