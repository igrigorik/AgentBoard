/**
 * WebMCP page bridge (MAIN world).
 *
 * document.modelContext is the single source of truth, whether Chromium or AgentBoard's polyfill
 * owns it. Raw RegisteredTool dictionaries stay in this realm because they contain Window objects;
 * only clone-safe descriptors cross to the extension.
 */
(function () {
  'use strict';

  const diagnostics = Object.freeze({
    log: () => console.log('[AgentBoard] WebMCP bridge event'),
    warn: () => console.warn('[AgentBoard] WebMCP bridge warning'),
    error: () => console.error('[AgentBoard] WebMCP bridge failure')
  });

  const previousBridge = window.__webmcpPageBridge;
  if (previousBridge) {
    if (typeof previousBridge.dispose === 'function') previousBridge.dispose();
    else return;
  }

  const JSONRPC = '2.0';
  const BRIDGE_ID = 'webmcp-main';
  class PublicBridgeError extends Error {}
  let api;
  try {
    api = document.modelContext;
  } catch {
    diagnostics.error();
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
      diagnostics.warn();
      return null;
    }

    let name;
    let description;
    try {
      ({ name, description } = rawTool);
    } catch {
      diagnostics.warn();
      return null;
    }

    if (typeof name !== 'string' || !name || typeof description !== 'string') {
      diagnostics.warn();
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
    } catch {
      diagnostics.warn();
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
        diagnostics.warn();
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
    } catch {
      if (disposed || generation !== publishGeneration) return;

      diagnostics.error();
      if (retryOnFailure) {
        setTimeout(() => {
          if (disposed || generation !== publishGeneration) return;
          publishCatalog(false).catch(() => diagnostics.error());
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
      publishCatalog().catch(() => diagnostics.error());
    });
  }

  function raceWithAbort(operation, signal) {
    if (signal.aborted) return Promise.reject(signal.reason);

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback) => (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        callback(value);
      };
      const onAbort = settle(reject);
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(operation).then(settle(resolve), settle(reject));
    });
  }

  async function executeTool(name, args, signal) {
    if (typeof name !== 'string' || !name) throw new PublicBridgeError('Tool name is required');

    let catalog;
    try {
      catalog = await collectCatalog();
    } catch {
      throw new PublicBridgeError('Tool catalog is unavailable');
    }
    if (catalog.ambiguousNames.has(name)) {
      throw new PublicBridgeError('Tool name is ambiguous');
    }

    const registeredTool = catalog.routes.get(name);
    if (!registeredTool) throw new PublicBridgeError('Tool was not found');

    const methods = getApiMethods();
    if (!methods) throw new PublicBridgeError('Tool catalog is unavailable');
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
      }
      return;
    }

    if (message.method === 'tools/list') {
      try {
        await publishCatalog();
      } catch {
        diagnostics.error();
      }
      return;
    }

    if (message.id === undefined || message.id === null) return;
    if (message.method !== 'tools/call') return;

    const { name, arguments: args } = message.params || {};
    const controller = new AbortController();
    pendingExecutions.set(message.id, controller);
    try {
      const result = await raceWithAbort(
        executeTool(name, args, controller.signal),
        controller.signal
      );
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!disposed) postToExtension({ jsonrpc: JSONRPC, id: message.id, result });
    } catch (error) {
      const publicMessage = controller.signal.aborted
        ? 'Tool execution cancelled'
        : error instanceof PublicBridgeError
          ? error.message
          : 'Tool execution failed';
      postToExtension({
        jsonrpc: JSONRPC,
        id: message.id,
        error: {
          code: -32000,
          message: publicMessage
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
      publishCatalog().catch(() => diagnostics.error());
    } catch {
      postCatalog([], { unavailable: true });
      diagnostics.error();
    }
  } else {
    postCatalog([], { unavailable: true });
    diagnostics.error();
  }

  diagnostics.log();
})();
