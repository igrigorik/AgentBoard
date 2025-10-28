/**
 * WebMCP Page Bridge (MAIN World)
 * Bridges window.agent events to the extension via postMessage
 * Executes in MAIN world with full access to page runtime
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
   * Initialize bridge if window.agent exists
   */
  function initBridge() {
    if (!window.agent || typeof window.agent.addEventListener !== 'function') {
      console.warn('[WebMCP Bridge] window.agent not found or invalid');
      return;
    }

    console.log('[WebMCP Bridge] Initializing in MAIN world');

    // Get current tools immediately - in case any were registered before we got here
    const currentTools = window.agent.listTools();
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
    window.agent.addEventListener('tools/listChanged', () => {
      try {
        const tools = window.agent.listTools();
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
          const tools = window.agent.listTools();

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
          // Delegate to window.agent
          const result = await window.agent.callTool(name, args || {});

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

  // Initialize immediately if window.agent exists
  if (window.agent) {
    initBridge();
  } else {
    // If window.agent doesn't exist yet, it might be loaded later
    // This shouldn't happen if polyfill is injected at document_start
    console.warn('[WebMCP Bridge] window.agent not found at injection time');
  }
})();
