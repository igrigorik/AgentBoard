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

  const diagnostics = Object.freeze({
    log: () => console.log('[AgentBoard] WebMCP bootstrap event'),
    warn: () => console.warn('[AgentBoard] WebMCP bootstrap warning'),
    callbackFailure: () => console.error('[AgentBoard] WebMCP tool callback failed'),
    serializationFailure: () => console.error('[AgentBoard] WebMCP result serialization failed')
  });

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
      diagnostics.log();
    } catch {
      diagnostics.warn();
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

  function unknownError() {
    return new DOMException('WebMCP tool execution failed', 'UnknownError');
  }

  function serializeExecutionResult(value) {
    const serialized =
      value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
    return serialized || 'Operation succeeded';
  }

  function dispatchToolEvent(type, toolName) {
    const event = new Event(type);
    Object.defineProperty(event, 'toolName', {
      value: toolName,
      configurable: true,
      enumerable: true
    });
    window.dispatchEvent(event);
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
        try {
          inputSchema = JSON.stringify(rawTool.inputSchema);
          if (inputSchema === undefined) {
            return Promise.reject(
              new TypeError('Invalid input schema: JSON.stringify() returned undefined')
            );
          }
        } catch (error) {
          return Promise.reject(error);
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
          ? String(rawTool.title).toWellFormed()
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
      const descriptor = {};
      for (const member of ['name', 'description', 'window', 'origin']) {
        const value = tool[member];
        if (value === undefined) {
          return Promise.reject(new TypeError(`Required member '${member}' is undefined`));
        }
        descriptor[member] = value;
      }

      const name = String(descriptor.name);
      // Trigger the required DOMString conversion even though routing does not use the description.
      String(descriptor.description);
      if (!(descriptor.window instanceof Window)) {
        return Promise.reject(new TypeError("The 'window' member must be a Window"));
      }
      const origin = String(descriptor.origin).toWellFormed();

      const options = rawOptions ?? {};
      const signal = options.signal;
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw new TypeError("The 'signal' member must be an AbortSignal");
      }
      if (signal?.aborted) return Promise.reject(signal.reason);

      const entry =
        descriptor.window === window && origin === window.location.origin
          ? this.#tools.get(name)
          : null;
      if (!entry) return Promise.reject(unknownError());

      let input;
      try {
        input = JSON.parse(String(inputArguments));
      } catch {
        return Promise.reject(unknownError());
      }
      if (input === null || typeof input !== 'object') {
        return Promise.reject(unknownError());
      }

      return new Promise((resolve, reject) => {
        let settled = false;
        const callbackController = new AbortController();
        const finish = (callback, value) => {
          if (settled) return false;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          callback(value);
          return true;
        };
        const onAbort = () => {
          if (!finish(reject, signal.reason)) return;
          // Caller rejection runs first; target cancellation crosses a browser boundary in Chromium.
          setTimeout(() => {
            callbackController.abort(abortError());
            dispatchToolEvent('toolcancel', name);
          }, 0);
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        let result;
        let callbackFailed = false;
        try {
          result = Reflect.apply(entry.execute, undefined, [
            input,
            { signal: callbackController.signal }
          ]);
        } catch {
          callbackFailed = true;
        }
        dispatchToolEvent('toolactivated', name);

        if (callbackFailed) {
          if (!settled) {
            diagnostics.callbackFailure();
            finish(reject, unknownError());
          }
          return;
        }

        Promise.resolve(result).then(
          (value) => {
            if (settled) return;
            try {
              finish(resolve, serializeExecutionResult(value));
            } catch {
              diagnostics.serializationFailure();
              finish(reject, unknownError());
            }
          },
          () => {
            if (settled) return;
            diagnostics.callbackFailure();
            finish(reject, unknownError());
          }
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
    diagnostics.log();
    return;
  }
  if (existingModelContext != null) {
    diagnostics.warn();
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
      executeTool: api.executeTool
    };
    diagnostics.log();
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

  diagnostics.log();
})();
