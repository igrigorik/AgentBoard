/**
 * WebMCP Page Bridge (MAIN World)
 * Bridges document.modelContext events to the extension via postMessage
 * Executes in MAIN world with full access to page runtime
 *
 * Aligns with the current WebMCP shape (Chrome 150+): the page-side and agent-side
 * APIs are unified on document.modelContext (navigator.modelContext is the deprecated
 * alias). There is no more navigator.modelContextTesting.
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
   * Strip native-only / non-serializable fields (e.g. the tool's `window`) so the
   * descriptors survive structured-clone when posted to the extension. inputSchema
   * is left as-is (a JSON string in the native shape); the background parses it.
   */
  function sanitizeTools(list) {
    return (list || []).map((t) => {
      const entry = { name: t.name, description: t.description, inputSchema: t.inputSchema };
      if (t.annotations != null) entry.annotations = t.annotations;
      return entry;
    });
  }

  /**
   * Get the WebMCP agent-side API for discovering and executing tools.
   *
   * Current shape (Chrome 150+): everything lives on document.modelContext
   * (navigator.modelContext is the deprecated alias; our polyfill mirrors both).
   *   - getTools({ fromOrigins })                async discovery
   *   - executeTool(toolObject, argsJson)        async execution (takes the tool obj)
   *   - 'toolchange' event                       via addEventListener
   */
  function getAgentAPI() {
    const mc = (typeof document !== 'undefined' && document.modelContext) || navigator.modelContext;

    if (mc && typeof mc.getTools === 'function') {
      // Our polyfill tags modelContext with an `errors` property; native does not.
      const native = !Object.prototype.hasOwnProperty.call(mc, 'errors');
      return {
        native,
        // Async snapshot of serializable descriptors.
        listTools: async () => sanitizeTools(await mc.getTools()),
        // Native executeTool takes the tool OBJECT + JSON-string args; resolve name -> tool.
        executeTool: async (name, args) => {
          const list = await mc.getTools();
          const tool = list.find((t) => t && t.name === name);
          if (!tool) throw new Error(`Tool '${name}' not found`);
          return mc.executeTool(tool, JSON.stringify(args ?? {}));
        },
        // Fires whenever the tool list changes.
        subscribe: (cb) => mc.addEventListener('toolchange', cb)
      };
    }

    // Legacy fallback: window.agent shim (older AgentBoard polyfills).
    if (window.agent && typeof window.agent.getTools === 'function') {
      const a = window.agent;
      return {
        native: false,
        listTools: async () => sanitizeTools(await a.getTools()),
        executeTool: async (name, args) => {
          const list = await a.getTools();
          const tool = list.find((t) => t && t.name === name);
          if (!tool) throw new Error(`Tool '${name}' not found`);
          return a.executeTool(tool, JSON.stringify(args ?? {}));
        },
        subscribe: (cb) => a.addEventListener('toolchange', cb)
      };
    }
    return null;
  }

  /**
   * Initialize bridge using the agent-side API
   */
  async function initBridge() {
    const agentAPI = getAgentAPI();

    if (!agentAPI) {
      console.warn('[WebMCP Bridge] No WebMCP API found (document.modelContext, navigator.modelContext, or window.agent)');
      return;
    }

    console.log('[WebMCP Bridge] Initializing in MAIN world', agentAPI.native ? '(native Chrome API)' : '(polyfill)');

    // Fetch the current tool list and forward it to the extension as tools/listChanged.
    const forwardTools = async (extra) => {
      const tools = await agentAPI.listTools();
      postToExtension({
        jsonrpc: JSONRPC,
        method: 'tools/listChanged',
        params: {
          tools,
          origin: location.origin,
          timestamp: Date.now(),
          ...(extra || {})
        }
      });
      return tools;
    };

    // Send initial snapshot if there are already tools (registered before we got here)
    try {
      const currentTools = await agentAPI.listTools();
      console.log('[WebMCP Bridge] Current tools on init:', currentTools);
      if (currentTools.length > 0) {
        await forwardTools({ initial: true });
        console.log('[WebMCP Bridge] Sent initial snapshot with', currentTools.length, 'existing tools');
      }
    } catch (err) {
      console.error('[WebMCP Bridge] Failed initial tools snapshot:', err);
    }

    // Subscribe to tool registry changes ('toolchange' event)
    agentAPI.subscribe(() => {
      forwardTools()
        .then((tools) =>
          console.log('[WebMCP Bridge] Forwarded tools/listChanged', tools.length, 'tools')
        )
        .catch((err) => console.error('[WebMCP Bridge] Failed to forward tools/listChanged:', err));
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
          const tools = await forwardTools({ requested: true });
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
                toolName: error?.toolName,
                stack: error?.stack
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

  // Guard against initializing more than once (injection + ready event could both fire)
  let bridgeInitialized = false;
  function initBridgeOnce() {
    if (bridgeInitialized || !getAgentAPI()) return;
    bridgeInitialized = true;
    initBridge();
  }

  // The polyfill defers its API registration to DOMContentLoaded (so OriginTrial
  // registrants can enable the native API first), so the WebMCP API may not exist
  // when we're injected. Instead of giving up, wait for the 'webmcp:polyfill-ready'
  // signal. Native APIs are present immediately, so this also handles them without delay.
  if (getAgentAPI()) {
    initBridgeOnce();
  } else if (!window.__webmcpReady) {
    console.log('[WebMCP Bridge] WebMCP API not ready yet, waiting for polyfill');
    window.addEventListener('webmcp:polyfill-ready', initBridgeOnce, { once: true });
  } else {
    // Ready flag set but no API surfaced — nothing to bridge (should not happen)
    console.warn('[WebMCP Bridge] Polyfill ready but no WebMCP API found');
  }
})();
