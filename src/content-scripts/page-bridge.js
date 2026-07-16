/**
 * WebMCP page bridge (MAIN world).
 *
 * document.modelContext is the single source of truth, whether Chromium or AgentBoard's polyfill
 * owns it. Raw RegisteredTool dictionaries stay in this realm because they contain Window objects;
 * only clone-safe descriptors cross to the extension.
 */
(function () {
  'use strict';

  const previousBridge = window.__webmcpPageBridge;
  if (previousBridge) {
    if (typeof previousBridge.dispose === 'function') previousBridge.dispose();
    else return;
  }

  const JSONRPC = '2.0';
  const BRIDGE_ID = 'webmcp-main';
  let api;
  try {
    api = document.modelContext;
  } catch (error) {
    console.error('[WebMCP Bridge] Failed to read document.modelContext:', error);
    api = null;
  }

  let disposed = false;
  let publishGeneration = 0;
  let refreshScheduled = false;
  const pendingExecutions = new Map();

  function postToExtension(message) {
    window.postMessage(
      {
        source: BRIDGE_ID,
        ...message
      },
      '*'
    );
  }

  function cloneJsonValue(value) {
    if (typeof value === 'string') return value;
    return JSON.parse(JSON.stringify(value));
  }

  function sanitizeTool(rawTool) {
    if (!rawTool || typeof rawTool !== 'object') {
      console.warn('[WebMCP Bridge] Ignoring malformed tool: expected an object');
      return null;
    }

    let name;
    let description;
    try {
      ({ name, description } = rawTool);
    } catch (error) {
      console.warn('[WebMCP Bridge] Ignoring malformed tool with unreadable metadata:', error);
      return null;
    }

    if (typeof name !== 'string' || !name || typeof description !== 'string') {
      console.warn('[WebMCP Bridge] Ignoring malformed tool: invalid name or description');
      return null;
    }

    try {
      const descriptor = { name, description };
      if (rawTool.inputSchema !== undefined) {
        descriptor.inputSchema = cloneJsonValue(rawTool.inputSchema);
      }
      if (rawTool.annotations !== undefined) {
        descriptor.annotations = cloneJsonValue(rawTool.annotations);
      }
      return descriptor;
    } catch (error) {
      console.warn(`[WebMCP Bridge] Ignoring non-serializable tool "${name}":`, error);
      return null;
    }
  }

  let apiMethods = null;
  function getApiMethods() {
    if (apiMethods) return apiMethods;
    try {
      const getTools = api?.getTools;
      const executeTool = api?.executeTool;
      const addEventListener = api?.addEventListener;
      if (
        typeof getTools !== 'function' ||
        typeof executeTool !== 'function' ||
        typeof addEventListener !== 'function'
      ) {
        return null;
      }
      apiMethods = { getTools, executeTool, addEventListener };
      return apiMethods;
    } catch {
      return null;
    }
  }

  /**
   * Build routes from one fresh browser observation. Filtering by Window preserves Chromium's
   * (document, name) ownership when the native API includes same-origin descendant-frame tools.
   */
  async function collectCatalog() {
    const methods = getApiMethods();
    if (!methods) throw new Error('document.modelContext is unavailable or incomplete');

    const rawTools = await Reflect.apply(methods.getTools, api, []);
    if (!Array.isArray(rawTools)) {
      throw new TypeError('document.modelContext.getTools() did not return an array');
    }

    const entriesByName = new Map();
    for (const rawTool of rawTools) {
      try {
        if (rawTool?.window !== window) continue;
      } catch {
        continue;
      }

      const publicTool = sanitizeTool(rawTool);
      if (!publicTool) continue;

      const entries = entriesByName.get(publicTool.name) || [];
      entries.push({ publicTool, rawTool });
      entriesByName.set(publicTool.name, entries);
    }

    const tools = [];
    const routes = new Map();
    const ambiguousNames = new Set();

    for (const [name, entries] of entriesByName) {
      if (entries.length !== 1) {
        ambiguousNames.add(name);
        console.warn(`[WebMCP Bridge] Omitting ambiguous tool "${name}"`);
        continue;
      }

      tools.push(entries[0].publicTool);
      routes.set(name, entries[0].rawTool);
    }

    tools.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    return { tools, routes, ambiguousNames };
  }

  function postCatalog(tools, extra = {}) {
    postToExtension({
      jsonrpc: JSONRPC,
      method: 'tools/listChanged',
      params: {
        tools,
        origin: location.origin,
        timestamp: Date.now(),
        ...extra
      }
    });
  }

  async function publishCatalog(retryOnFailure = true) {
    const generation = ++publishGeneration;
    let catalog;
    try {
      catalog = await collectCatalog();
    } catch (error) {
      if (disposed || generation !== publishGeneration) return;

      console.error('[WebMCP Bridge] Failed to read document.modelContext tools:', error);
      if (retryOnFailure) {
        setTimeout(() => {
          if (disposed || generation !== publishGeneration) return;
          publishCatalog(false).catch((retryError) =>
            console.error('[WebMCP Bridge] Failed to publish unavailable catalog:', retryError)
          );
        }, 0);
      } else {
        // Native policy/security failures must not leave an old catalog active indefinitely.
        // Selection remains native; this is an explicit unavailable state, not backend fallback.
        postCatalog([], { unavailable: true });
      }
      return;
    }

    if (disposed || generation !== publishGeneration) return;
    postCatalog(catalog.tools);
  }

  function scheduleRefresh() {
    if (disposed || refreshScheduled) return;
    refreshScheduled = true;
    queueMicrotask(() => {
      refreshScheduled = false;
      if (disposed) return;
      publishCatalog().catch((error) =>
        console.error('[WebMCP Bridge] Failed to publish changed tools:', error)
      );
    });
  }

  async function executeTool(name, args, signal) {
    if (typeof name !== 'string' || !name) throw new TypeError('Tool name is required');

    const catalog = await collectCatalog();
    if (catalog.ambiguousNames.has(name)) {
      throw new Error(`Tool "${name}" is ambiguous`);
    }

    const registeredTool = catalog.routes.get(name);
    if (!registeredTool) throw new Error(`Tool "${name}" not found`);

    const methods = getApiMethods();
    if (!methods) throw new Error('document.modelContext is unavailable or incomplete');
    return Reflect.apply(methods.executeTool, api, [
      registeredTool,
      JSON.stringify(args ?? {}),
      { signal }
    ]);
  }

  async function onMessage(event) {
    if (disposed || event.source !== window) return;
    if (!event.data || event.data.source !== 'webmcp-bridge') return;
    if (event.data.jsonrpc !== JSONRPC) return;

    const message = event.data;
    if (message.method === 'tools/cancel') {
      const controller = pendingExecutions.get(message.params?.id);
      if (controller) {
        controller.abort(new DOMException('Tool call cancelled', 'AbortError'));
        pendingExecutions.delete(message.params.id);
      }
      return;
    }

    if (message.method === 'tools/list') {
      try {
        await publishCatalog();
      } catch (error) {
        console.error('[WebMCP Bridge] Failed explicit tools snapshot:', error);
      }
      return;
    }

    if (message.id === undefined || message.id === null) return;
    if (message.method !== 'tools/call') return;

    const { name, arguments: args } = message.params || {};
    const controller = new AbortController();
    pendingExecutions.set(message.id, controller);
    try {
      const result = await executeTool(name, args, controller.signal);
      if (!disposed) postToExtension({ jsonrpc: JSONRPC, id: message.id, result });
    } catch (error) {
      postToExtension({
        jsonrpc: JSONRPC,
        id: message.id,
        error: {
          code: -32000,
          message: error?.message || String(error),
          data: {
            name: error?.name,
            stack: error?.stack
          }
        }
      });
    } finally {
      if (pendingExecutions.get(message.id) === controller) pendingExecutions.delete(message.id);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const controller of pendingExecutions.values()) {
      controller.abort(new DOMException('Document bridge disposed', 'AbortError'));
    }
    pendingExecutions.clear();
    window.removeEventListener('message', onMessage);
    try {
      api?.removeEventListener?.('toolchange', scheduleRefresh);
    } catch {
      // A hostile or torn-down page API must not prevent bridge disposal.
    }
    if (window.__webmcpPageBridge === controller) delete window.__webmcpPageBridge;
  }

  const controller = { version: 3, dispose };
  window.__webmcpPageBridge = controller;
  window.addEventListener('message', onMessage);

  const methods = getApiMethods();
  if (methods) {
    try {
      Reflect.apply(methods.addEventListener, api, ['toolchange', scheduleRefresh]);
      publishCatalog().catch((error) =>
        console.error('[WebMCP Bridge] Failed initial tools snapshot:', error)
      );
    } catch (error) {
      postCatalog([], { unavailable: true });
      console.error('[WebMCP Bridge] Failed to subscribe to document.modelContext:', error);
    }
  } else {
    postCatalog([], { unavailable: true });
    console.error('[WebMCP Bridge] document.modelContext is unavailable or incomplete');
  }

  console.log('[WebMCP Bridge] Ready and listening');
})();
