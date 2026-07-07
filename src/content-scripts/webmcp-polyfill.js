/**
 * WebMCP Polyfill - Complete implementation of WebMCP API
 * Provides tool registration and invocation capabilities for web agents
 *
 * Aligns with WebMCP proposed spec:
 * https://github.com/webmachinelearning/webmcp/blob/main/docs/proposal.md
 *
 * Primary API: document.modelContext (Chrome 150+; navigator.modelContext is the
 * deprecated alias and is mirrored for older callers).
 * Backward compat: window.agent (thin alias for AgentBoard's own injected tools).
 *
 * Matches the native document.modelContext shape:
 * - registerTool(tool, { signal })          page-side; AbortSignal unregisters
 * - getTools({ fromOrigins })               agent-side discovery (async)
 * - executeTool(tool, argsJson, { signal })  agent-side execution (async)
 * - 'toolchange' event                       fired via addEventListener
 */
(function installWebmcpPolyfill(domContentLoadedEvent) {
  'use strict';

  // Defer registration until DOMContentLoaded. This content script runs at
  // document_start (readyState === 'loading'), before the parser has processed any
  // OriginTrial meta tokens or run page scripts. OriginTrial tokens are applied
  // during parsing, so by DOMContentLoaded the native modelContext API is enabled
  // if the trial is present, letting us correctly defer to native instead of
  // installing our polyfill. Re-running at the page's own DCL also lands before the
  // extension injects its consumer scripts (page-bridge, tools, user scripts), which
  // arrive via webNavigation.onDOMContentLoaded — a background round-trip that runs
  // after the page's DCL handlers — so the API is ready when they need it.
  //
  // domContentLoadedEvent is set only when invoked by the listener below; on the
  // initial synchronous call it is undefined, which is how we tell "defer" from
  // "install now" without relying on readyState (which some environments don't
  // advance when the event is dispatched synchronously).
  if (!domContentLoadedEvent && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installWebmcpPolyfill, { once: true });
    return;
  }

  // Readiness signal for any consumer that still runs before this does
  // (defense-in-depth): a window.__webmcpReady flag plus a 'webmcp:polyfill-ready'
  // event, both emitted once the API (native or polyfill) is ready.
  function signalReady() {
    window.__webmcpReady = true;
    try {
      window.dispatchEvent(new Event('webmcp:polyfill-ready'));
    } catch {
      /* dispatch must never break registration */
    }
  }

  // Guard: already initialized (either by us or native browser support).
  // Re-checked here at DCL time so OriginTrial registrants have had a chance to
  // enable the native API before we decide to polyfill.
  if ('modelContext' in navigator || 'modelContext' in document) {
    console.log('[WebMCP] Native navigator.modelContext detected, skipping polyfill');
    // Still set up window.agent alias for backward compat if not present
    if (!('agent' in window)) {
      Object.defineProperty(window, 'agent', {
        value: document.modelContext || navigator.modelContext,
        writable: false,
        configurable: false,
        enumerable: true
      });
    }
    signalReady();
    return;
  }

  class WebMCPError extends Error {
    constructor(message) {
      super(message);
      this.name = 'WebMCPError';
    }
  }

  class ToolNotFoundError extends WebMCPError {
    constructor(toolName) {
      super(`Tool '${toolName}' not found`);
      this.name = 'ToolNotFoundError';
      this.toolName = toolName;
    }
  }

  class ValidationError extends WebMCPError {
    constructor(message, errors = []) {
      super(message);
      this.name = 'ValidationError';
      this.errors = errors;
    }
  }

  class ExecutionError extends WebMCPError {
    constructor(message, originalError) {
      super(message);
      this.name = 'ExecutionError';
      this.originalError = originalError;
    }
  }

  function validateParams(params, schema, path = '') {
    const errors = [];
    if (!schema) return errors;

    // Helper to get type of value
    function getType(value) {
      if (value === null) return 'null';
      if (Array.isArray(value)) return 'array';
      return typeof value;
    }

    // Helper to create path string
    function makePath(base, key) {
      if (!base) return key;
      if (typeof key === 'number') return `${base}[${key}]`;
      return `${base}.${key}`;
    }

    const valueType = getType(params);

    // Log validation context for debugging
    if (!path) {
      console.log('[WebMCP Validation] Starting validation with params:', params);
      console.log('[WebMCP Validation] Schema:', schema);
    }

    // Type validation
    if (schema.type) {
      // Handle integer special case
      if (schema.type === 'integer') {
        if (typeof params !== 'number' || !Number.isInteger(params)) {
          errors.push(`${path || 'value'}: expected integer, got ${valueType}`);
          return errors; // Stop validating if basic type is wrong
        }
      }
      // Handle other types
      else if (schema.type !== valueType) {
        errors.push(`${path || 'value'}: expected ${schema.type}, got ${valueType}`);
        return errors; // Stop validating if basic type is wrong
      }
    }

    // Object validation
    if (schema.type === 'object' && valueType === 'object') {
      // Check required fields
      if (schema.required && Array.isArray(schema.required)) {
        for (const field of schema.required) {
          if (!(field in params)) {
            const fieldPath = makePath(path, field);
            errors.push(`${fieldPath}: required field missing`);
          }
        }
      }

      // Validate properties
      if (schema.properties) {
        for (const [key, value] of Object.entries(params)) {
          const propSchema = schema.properties[key];
          const propPath = makePath(path, key);

          if (propSchema) {
            // Recursively validate nested properties
            const propErrors = validateParams(value, propSchema, propPath);
            errors.push(...propErrors);
          } else if (schema.additionalProperties === false) {
            // Only reject additional properties if explicitly set to false
            errors.push(`${propPath}: additional property not allowed`);
          }
        }
      }
    }

    // Array validation
    else if (schema.type === 'array' && valueType === 'array') {
      // Validate minItems/maxItems if specified
      if (schema.minItems !== undefined && params.length < schema.minItems) {
        errors.push(`${path || 'array'}: requires at least ${schema.minItems} items, got ${params.length}`);
      }
      if (schema.maxItems !== undefined && params.length > schema.maxItems) {
        errors.push(`${path || 'array'}: requires at most ${schema.maxItems} items, got ${params.length}`);
      }

      // Validate each item if items schema is provided
      if (schema.items) {
        if (!path) {
          console.log('[WebMCP Validation] Validating array items with schema:', schema.items);
        }
        params.forEach((item, index) => {
          const itemPath = makePath(path, index);
          const itemErrors = validateParams(item, schema.items, itemPath);
          errors.push(...itemErrors);
        });
      }
    }

    // Enum validation
    else if (schema.enum && !schema.enum.includes(params)) {
      errors.push(`${path || 'value'}: must be one of: ${schema.enum.join(', ')}`);
    }

    // Format validation for strings (basic support)
    else if (schema.type === 'string' && schema.format) {
      if (schema.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(params)) {
        errors.push(`${path || 'value'}: invalid email format`);
      }
      // Add more format validators as needed
    }

    // Return errors for recursive calls
    if (path) {
      return errors;
    }

    // For root call, throw if there are errors
    if (errors.length) {
      console.error('[WebMCP Validation] Validation failed with errors:', errors);
      console.error('[WebMCP Validation] Failed params:', params);
      console.error('[WebMCP Validation] Failed schema:', schema);
      throw new ValidationError('Parameter validation failed', errors);
    }

    return errors;
  }

  /**
   * Create an agent context object to pass to tool execute functions
   * Per WebMCP spec, this provides requestUserInteraction() API
   */
  function createAgentContext() {
    return {
      /**
       * Request user interaction during tool execution
       * Allows tools to prompt for confirmation, input, etc.
       *
       * @param {Function} interactionFn - Async function that performs UI interaction
       * @returns {Promise<any>} - Result of the interaction function
       *
       * Example:
       *   const confirmed = await agent.requestUserInteraction(async () => {
       *     return confirm('Proceed with purchase?');
       *   });
       */
      async requestUserInteraction(interactionFn) {
        if (typeof interactionFn !== 'function') {
          throw new ValidationError('requestUserInteraction requires a function');
        }
        // Execute the interaction function - it handles its own UI
        return await interactionFn();
      }
    };
  }

  // Shared tool registry, keyed by name. We keep the parsed (object) inputSchema and
  // the execute() fn internally; getTools() exposes the native-shaped descriptor with
  // inputSchema serialized as a JSON string.
  const tools = new Map();

  function validateAndNormalizeTool(tool) {
    if (!tool || typeof tool !== 'object') {
      throw new ValidationError('Tool must be an object');
    }
    const { name, description, inputSchema, execute, annotations } = tool;
    if (!name || typeof name !== 'string') throw new ValidationError('Tool must have a string name');
    if (!description || typeof description !== 'string') throw new ValidationError('Tool must have a string description');
    if (typeof execute !== 'function') throw new ValidationError('Tool must have an execute function');
    const normalized = {
      name,
      description,
      inputSchema: inputSchema || { type: 'object', properties: {} },
      execute
    };
    // Preserve optional annotations metadata (readOnlyHint, destructiveHint, etc.)
    if (annotations != null) normalized.annotations = annotations;
    return normalized;
  }

  /**
   * Internal function to execute a tool by name with parsed (object) params.
   * Backs modelContext.executeTool() and the window.agent legacy shim.
   */
  async function executeToolInternal(toolName, params = {}) {
    if (!tools.has(toolName)) {
      throw new ToolNotFoundError(toolName);
    }
    const tool = tools.get(toolName);
    try {
      validateParams(params, tool.inputSchema);
      // Create agent context for this tool execution
      const agentContext = createAgentContext();
      // Per WebMCP spec: execute(params, agent)
      return await Promise.resolve(tool.execute(params, agentContext));
    } catch (err) {
      if (err instanceof ValidationError || err instanceof ExecutionError) throw err;
      // err.message can be "" (falsy but valid string) — check typeof, not truthiness
      const detail = (err instanceof Error && typeof err.message === 'string' && err.message !== '')
        ? err.message
        : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      throw new ExecutionError(`Tool '${toolName}' execution failed: ${detail}${stack ? '\n' + stack : ''}`, err);
    }
  }

  /**
   * Build the native-shaped descriptors returned by getTools(): sorted alphabetically
   * by name, inputSchema serialized as a JSON string, plus the tool's origin. The
   * execute() fn is intentionally omitted (agents invoke via executeTool()).
   */
  function listToolsInternal() {
    return Array.from(tools.values())
      .map(({ name, description, inputSchema, annotations }) => {
        const entry = {
          name,
          description,
          inputSchema: typeof inputSchema === 'string' ? inputSchema : JSON.stringify(inputSchema),
          origin: location.origin
        };
        if (annotations != null) entry.annotations = annotations;
        return entry;
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * WebMCP API: document.modelContext (mirrored on navigator.modelContext).
   * Matches Chrome's native shape exactly:
   *   - registerTool(tool, { signal })           page-side; AbortSignal unregisters
   *   - getTools({ fromOrigins })                agent-side discovery (async)
   *   - executeTool(tool, argsJson, { signal })  agent-side execution (async)
   *   - 'toolchange' event                       via addEventListener (EventTarget)
   */
  class ModelContext extends EventTarget {
    /**
     * Register a single tool. Pass { signal } to unregister when the signal aborts.
     * Returns a promise to match the native (awaitable) API.
     */
    registerTool(rawTool, options = {}) {
      const tool = validateAndNormalizeTool(rawTool);
      if (tools.has(tool.name)) {
        // Allow replacement for hot reload
        console.warn(`[WebMCP] Replacing existing tool: ${tool.name}`);
      }
      tools.set(tool.name, tool);

      // AbortSignal-based unregistration (native contract).
      const signal = options && options.signal;
      if (signal) {
        if (signal.aborted) {
          tools.delete(tool.name);
        } else {
          signal.addEventListener(
            'abort',
            () => {
              // Only remove if this exact registration is still the active one.
              if (tools.get(tool.name) === tool) {
                tools.delete(tool.name);
                notifyToolChange();
              }
            },
            { once: true }
          );
        }
      }

      notifyToolChange();
      return Promise.resolve();
    }

    /**
     * Discover registered tools (agent-side). Async; returns native-shaped
     * descriptors. fromOrigins is accepted for API compatibility but the polyfill
     * is single-origin, so only same-origin tools ever exist.
     */
    async getTools() {
      return listToolsInternal();
    }

    /**
     * Execute a tool (agent-side). Native passes the tool object returned by
     * getTools(); we also accept a bare tool name. args may be a JSON string
     * (native) or an object (convenience).
     */
    async executeTool(tool, args = '{}') {
      const name = typeof tool === 'string' ? tool : tool && tool.name;
      const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
      return executeToolInternal(name, parsedArgs);
    }
  }

  const modelContext = new ModelContext();

  // Dispatch 'toolchange' on the next microtask so a burst of synchronous
  // registrations coalesces into a single notification.
  function notifyToolChange() {
    queueMicrotask(() => modelContext.dispatchEvent(new Event('toolchange')));
  }

  // Define document.modelContext (primary, per Chrome 150+) and mirror it on
  // navigator.modelContext (deprecated in Chrome 150, kept for older callers).
  Object.defineProperty(document, 'modelContext', {
    value: modelContext,
    writable: false,
    configurable: false,
    enumerable: true
  });
  Object.defineProperty(navigator, 'modelContext', {
    value: modelContext,
    writable: false,
    configurable: false,
    enumerable: true
  });

  // Backward-compatibility alias for AgentBoard's own injected tools and user
  // scripts, which register via window.agent.registerTool(...). Thin shim over the
  // unified modelContext; exposes just enough of the agent-side surface for console use.
  const agentCompat = {
    registerTool: (tool, options) => modelContext.registerTool(tool, options),
    getTools: () => modelContext.getTools(),
    executeTool: (tool, args) => modelContext.executeTool(tool, args),
    addEventListener: (type, cb) => modelContext.addEventListener(type, cb),
    removeEventListener: (type, cb) => modelContext.removeEventListener(type, cb)
  };
  Object.defineProperty(window, 'agent', {
    value: agentCompat,
    writable: false,
    configurable: false,
    enumerable: true
  });

  // Expose error classes for consumers
  const errorClasses = {
    WebMCPError,
    ToolNotFoundError,
    ValidationError,
    ExecutionError
  };
  modelContext.errors = errorClasses;
  window.agent.errors = errorClasses;

  // Create Trusted Types policy for user script injection
  if (typeof trustedTypes !== 'undefined') {
    try {
      window.__agentboardTTPolicy = trustedTypes.createPolicy('agentboard-user-scripts', {
        createScriptURL: (url) => {
          // Only allow same-origin blob: URLs (defense-in-depth)
          // Blob URLs are origin-bound by construction: blob:https://site.com/uuid
          const expectedPrefix = `blob:${window.location.origin}/`;
          if (url.startsWith(expectedPrefix)) {
            return url;
          }
          throw new TypeError(`AgentBoard policy only allows same-origin blob: URLs (expected ${expectedPrefix})`);
        }
      });
      console.log('[WebMCP] Created Trusted Types policy for user scripts');
    } catch (error) {
      console.warn('[WebMCP] Could not create Trusted Types policy:', error.message);
      console.warn('[WebMCP] User scripts may not work on this site due to Trusted Types');
    }
  }

  console.log('[WebMCP] Polyfill ready: document.modelContext (also navigator.modelContext, window.agent)');
  signalReady();
})();
