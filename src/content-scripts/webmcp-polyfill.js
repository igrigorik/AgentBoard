/**
 * AgentBoard WebMCP bootstrap (MAIN world).
 *
 * If Chromium already exposes its complete document.modelContext implementation, this script
 * leaves it untouched. Otherwise it installs a stable facade that selects exactly one backend on
 * first use: a native implementation exposed in the meantime, or AgentBoard's local polyfill.
 * Once selected, ownership never changes for the lifetime of the document.
 */
(function () {
  'use strict';

  function ensureTrustedTypesPolicy() {
    if (typeof trustedTypes === 'undefined' || window.__agentboardTTPolicy) return;

    try {
      window.__agentboardTTPolicy = trustedTypes.createPolicy('agentboard-user-scripts', {
        createScriptURL(url) {
          const expectedPrefix = `blob:${window.location.origin}/`;
          if (url.startsWith(expectedPrefix)) return url;
          throw new TypeError(
            `AgentBoard policy only allows same-origin blob: URLs (expected ${expectedPrefix})`
          );
        }
      });
      console.log('[WebMCP] Created Trusted Types policy for user scripts');
    } catch (error) {
      console.warn('[WebMCP] Could not create Trusted Types policy:', error?.message || error);
      console.warn('[WebMCP] User scripts may not work on this site due to Trusted Types');
    }
  }

  function isCompleteModelContext(value) {
    try {
      return Boolean(
        value &&
          typeof value === 'object' &&
          typeof value.registerTool === 'function' &&
          typeof value.getTools === 'function' &&
          typeof value.executeTool === 'function' &&
          typeof value.addEventListener === 'function'
      );
    } catch {
      return false;
    }
  }

  /**
   * Runtime-gated Web IDL attributes live on a prototype. Reading the descriptor directly avoids
   * recursing through AgentBoard's own document-level facade.
   */
  function readNativeModelContext() {
    let prototype = Object.getPrototypeOf(document);
    while (prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'modelContext');
      if (descriptor?.get) {
        try {
          const candidate = descriptor.get.call(document);
          return isCompleteModelContext(candidate) ? candidate : null;
        } catch {
          return null;
        }
      }
      prototype = Object.getPrototypeOf(prototype);
    }
    return null;
  }

  function invalidState(message) {
    return new DOMException(message, 'InvalidStateError');
  }

  function abortError(message = 'Execution cancelled.') {
    return new DOMException(message, 'AbortError');
  }

  function serializeExecutionResult(value) {
    if (value !== null && typeof value === 'object') {
      try {
        const serialized = JSON.stringify(value);
        if (serialized) return serialized;
      } catch {
        // Match Chromium's fallback to string conversion when JSON serialization fails.
      }
    }

    const serialized = String(value);
    return serialized || 'Operation succeeded';
  }

  class LocalModelContext extends EventTarget {
    #tools = new Map();
    #ontoolchange = null;

    registerTool(rawTool, rawOptions = {}) {
      if (this === null || !(this instanceof LocalModelContext)) {
        throw new TypeError('Illegal invocation');
      }
      if (!rawTool || typeof rawTool !== 'object') {
        throw new TypeError('Tool must be an object');
      }
      if (!Object.prototype.hasOwnProperty.call(rawTool, 'name')) {
        throw new TypeError("Required member 'name' is undefined");
      }
      if (!Object.prototype.hasOwnProperty.call(rawTool, 'description')) {
        throw new TypeError("Required member 'description' is undefined");
      }
      if (!Object.prototype.hasOwnProperty.call(rawTool, 'execute')) {
        throw new TypeError("Required member 'execute' is undefined");
      }

      const name = String(rawTool.name);
      const description = String(rawTool.description);
      const execute = rawTool.execute;
      const options = rawOptions ?? {};

      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) {
        return Promise.reject(invalidState('Invalid tool name'));
      }
      if (!description) {
        return Promise.reject(invalidState('Description is required'));
      }
      if (typeof execute !== 'function') {
        throw new TypeError("The 'execute' member must be a function");
      }
      if (this.#tools.has(name)) {
        return Promise.reject(invalidState('Duplicate tool name'));
      }

      let inputSchema;
      if (
        Object.prototype.hasOwnProperty.call(rawTool, 'inputSchema') &&
        rawTool.inputSchema !== undefined
      ) {
        inputSchema = JSON.stringify(rawTool.inputSchema);
        if (inputSchema === undefined) {
          throw new TypeError('Invalid input schema: JSON.stringify() returned undefined');
        }
      }

      const signal = options.signal;
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw new TypeError("The 'signal' member must be an AbortSignal");
      }
      if (signal?.aborted) return Promise.reject(signal.reason);

      const annotations = rawTool.annotations
        ? {
            readOnlyHint: Boolean(rawTool.annotations.readOnlyHint),
            untrustedContentHint: Boolean(rawTool.annotations.untrustedContentHint)
          }
        : undefined;
      const entry = {
        name,
        title: Object.prototype.hasOwnProperty.call(rawTool, 'title')
          ? String(rawTool.title)
          : '',
        description,
        inputSchema,
        annotations,
        execute
      };

      let resolveRegistration;
      let rejectRegistration;
      const registration = new Promise((resolve, reject) => {
        resolveRegistration = resolve;
        rejectRegistration = reject;
      });

      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            if (this.#tools.get(name) !== entry) return;
            this.#tools.delete(name);
            this.#queueToolChange();
            rejectRegistration(signal.reason);
          },
          { once: true }
        );
      }

      this.#tools.set(name, entry);
      this.#queueToolChange(resolveRegistration);
      return registration;
    }

    getTools(_options = {}) {
      if (this === null || !(this instanceof LocalModelContext)) {
        throw new TypeError('Illegal invocation');
      }

      const tools = Array.from(this.#tools.values())
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
        .map((entry) => {
          const descriptor = {
            name: entry.name,
            title: entry.title,
            description: entry.description,
            window,
            origin: window.location.origin
          };
          if (entry.inputSchema !== undefined) descriptor.inputSchema = entry.inputSchema;
          if (entry.annotations !== undefined) descriptor.annotations = { ...entry.annotations };
          return descriptor;
        });

      return Promise.resolve(tools);
    }

    executeTool(tool, inputArguments, rawOptions = {}) {
      if (this === null || !(this instanceof LocalModelContext)) {
        throw new TypeError('Illegal invocation');
      }
      if (!tool || typeof tool !== 'object') {
        throw new TypeError('RegisteredTool must be an object');
      }

      const options = rawOptions ?? {};
      const signal = options.signal;
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw new TypeError("The 'signal' member must be an AbortSignal");
      }
      if (signal?.aborted) return Promise.reject(abortError());

      const entry =
        tool.window === window && String(tool.origin) === window.location.origin
          ? this.#tools.get(String(tool.name))
          : null;
      if (!entry) return Promise.reject(invalidState('Tool is not registered in this document'));

      let input;
      try {
        input = JSON.parse(String(inputArguments));
      } catch {
        return Promise.reject(new TypeError('Failed to parse input arguments'));
      }
      if (input === null || typeof input !== 'object') {
        return Promise.reject(new TypeError('Input arguments must contain a JSON object'));
      }

      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          callback(value);
        };
        const onAbort = () => finish(reject, signal.reason);
        signal?.addEventListener('abort', onAbort, { once: true });

        Promise.resolve()
          .then(() => (settled ? undefined : Reflect.apply(entry.execute, undefined, [input])))
          .then((result) => (settled ? undefined : serializeExecutionResult(result)))
          .then(
            (result) => finish(resolve, result),
            (error) => finish(reject, error)
          );
      });
    }

    set ontoolchange(callback) {
      if (callback !== null && typeof callback !== 'function') {
        throw new TypeError('ontoolchange must be a function or null');
      }
      if (this.#ontoolchange) this.removeEventListener('toolchange', this.#ontoolchange);
      this.#ontoolchange = callback;
      if (callback) this.addEventListener('toolchange', callback);
    }

    get ontoolchange() {
      return this.#ontoolchange;
    }

    #queueToolChange(afterDispatch) {
      setTimeout(() => {
        this.dispatchEvent(new Event('toolchange'));
        afterDispatch?.();
      }, 0);
    }
  }

  Object.defineProperty(LocalModelContext.prototype, Symbol.toStringTag, {
    value: 'ModelContext'
  });

  ensureTrustedTypesPolicy();

  let existingModelContext;
  try {
    existingModelContext = document.modelContext;
  } catch {
    existingModelContext = null;
  }

  if (isCompleteModelContext(existingModelContext)) {
    console.log('[WebMCP] Native document.modelContext available');
    return;
  }
  if (existingModelContext != null) {
    console.warn('[WebMCP] Existing document.modelContext is incomplete; leaving it untouched');
    return;
  }

  let facade;
  let selectedBackend = null;

  function selectBackend() {
    if (selectedBackend) return selectedBackend;

    const native = readNativeModelContext();
    const api = native || new LocalModelContext();
    const forwardToolChange = () => facade.dispatchEvent(new Event('toolchange'));
    api.addEventListener('toolchange', forwardToolChange);

    selectedBackend = {
      api,
      registerTool: api.registerTool,
      getTools: api.getTools,
      executeTool: api.executeTool,
      kind: native ? 'native' : 'polyfill'
    };
    console.log(`[WebMCP] document.modelContext selected ${selectedBackend.kind} backend`);
    return selectedBackend;
  }

  class ModelContextFacade extends EventTarget {
    #ontoolchange = null;

    registerTool(...args) {
      if (this !== facade) throw new TypeError('Illegal invocation');
      const backend = selectBackend();
      return Reflect.apply(backend.registerTool, backend.api, args);
    }

    getTools(...args) {
      if (this !== facade) throw new TypeError('Illegal invocation');
      const backend = selectBackend();
      return Reflect.apply(backend.getTools, backend.api, args);
    }

    executeTool(...args) {
      if (this !== facade) throw new TypeError('Illegal invocation');
      const backend = selectBackend();
      return Reflect.apply(backend.executeTool, backend.api, args);
    }

    set ontoolchange(callback) {
      if (callback !== null && typeof callback !== 'function') {
        throw new TypeError('ontoolchange must be a function or null');
      }
      if (this.#ontoolchange) this.removeEventListener('toolchange', this.#ontoolchange);
      this.#ontoolchange = callback;
      if (callback) this.addEventListener('toolchange', callback);
    }

    get ontoolchange() {
      return this.#ontoolchange;
    }
  }

  Object.defineProperty(ModelContextFacade.prototype, Symbol.toStringTag, {
    value: 'ModelContext'
  });

  facade = new ModelContextFacade();
  Object.defineProperty(document, 'modelContext', {
    value: facade,
    writable: false,
    configurable: false,
    enumerable: true
  });

  console.log('[WebMCP] document.modelContext facade ready');
})();
