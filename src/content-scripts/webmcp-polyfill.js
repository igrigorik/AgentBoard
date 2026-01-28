/**
 * WebMCP Polyfill - Complete implementation of WebMCP API
 * Provides tool registration and invocation capabilities for web agents
 *
 * Aligns with WebMCP proposed spec:
 * https://github.com/webmachinelearning/webmcp/blob/main/docs/proposal.md
 *
 * API: window.navigator.modelContext
 * Backward compat: window.agent (alias)
 *
 * Chrome Canary native support:
 * - navigator.modelContextTesting (agent-side: listTools, executeTool, registerToolsChangedCallback)
 * - navigator.modelContext (page-side: provideContext, registerTool) - when available
 */
(function () {
  'use strict';

  // Guard: already initialized (either by us or native browser support)
  if ('modelContext' in navigator) {
    console.log('[WebMCP] Native navigator.modelContext detected, skipping polyfill');
    // Still set up window.agent alias for backward compat if not present
    if (!('agent' in window)) {
      Object.defineProperty(window, 'agent', {
        value: navigator.modelContext,
        writable: false,
        configurable: false,
        enumerable: true
      });
    }
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

  // Lightweight EventTarget-like impl
  function createEventTarget() {
    const listeners = new Map();
    return {
      addEventListener(type, listener) {
        if (typeof listener !== 'function') return;
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(listener);
      },
      removeEventListener(type, listener) {
        if (!listeners.has(type)) return;
        listeners.get(type).delete(listener);
      },
      dispatchEvent(event) {
        const cbs = listeners.get(event.type);
        if (!cbs) return;
        cbs.forEach(cb => {
          try { cb.call(this, event); } catch { /* swallow to not break others */ }
        });
      }
    };
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

  // Shared state between page-side (modelContext) and agent-side (modelContextTesting) APIs
  const tools = new Map();
  const events = createEventTarget();
  const toolsChangedCallbacks = [];

  // Forward internal events to toolsChangedCallbacks
  events.addEventListener('tools/listChanged', () => {
    for (const callback of toolsChangedCallbacks) {
      try {
        callback();
      } catch (err) {
        console.error('[WebMCP] Error in toolsChangedCallback:', err);
      }
    }
  });

  function validateAndNormalizeTool(tool) {
    if (!tool || typeof tool !== 'object') {
      throw new ValidationError('Tool must be an object');
    }
    const { name, description, inputSchema, execute } = tool;
    if (!name || typeof name !== 'string') throw new ValidationError('Tool must have a string name');
    if (!description || typeof description !== 'string') throw new ValidationError('Tool must have a string description');
    if (typeof execute !== 'function') throw new ValidationError('Tool must have an execute function');
    return {
      name,
      description,
      inputSchema: inputSchema || { type: 'object', properties: {} },
      execute
    };
  }

  /**
   * Internal function to execute a tool
   * Used by both modelContext.callTool (legacy) and modelContextTesting.executeTool
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
      throw new ExecutionError(`Tool '${toolName}' execution failed: ${err && err.message ? err.message : String(err)}`, err);
    }
  }

  /**
   * Internal function to list tools
   * Used by both APIs
   */
  function listToolsInternal() {
    return Array.from(tools.values()).map(({ name, description, inputSchema }) => ({
      name, description, inputSchema
    }));
  }

  /**
   * PAGE-SIDE API: navigator.modelContext
   * For pages to register tools with the agent
   */
  const modelContext = {
    /**
     * Replace entire tool set (per WebMCP spec)
     * Clears any pre-existing tools before registering new ones
     */
    provideContext(context) {
      if (!context || !context.tools || !Array.isArray(context.tools)) {
        throw new ValidationError('Context must have a tools array');
      }
      tools.clear();
      for (const raw of context.tools) {
        const tool = validateAndNormalizeTool(raw);
        if (tools.has(tool.name)) {
          throw new ValidationError(`Duplicate tool name: ${tool.name}`);
        }
        tools.set(tool.name, tool);
      }
      // Notify listeners
      queueMicrotask(() => events.dispatchEvent({ type: 'tools/listChanged' }));
    },

    /**
     * Register a single tool (per WebMCP spec)
     * Adds to existing tools without clearing
     */
    registerTool(rawTool) {
      const tool = validateAndNormalizeTool(rawTool);
      if (tools.has(tool.name)) {
        // Allow replacement for hot reload
        console.warn(`[WebMCP] Replacing existing tool: ${tool.name}`);
      }
      tools.set(tool.name, tool);
      queueMicrotask(() => events.dispatchEvent({ type: 'tools/listChanged' }));
    },

    /**
     * Unregister a tool by name (per WebMCP spec)
     */
    unregisterTool(toolName) {
      if (typeof toolName !== 'string') {
        throw new ValidationError('Tool name must be a string');
      }
      const existed = tools.delete(toolName);
      if (existed) {
        queueMicrotask(() => events.dispatchEvent({ type: 'tools/listChanged' }));
      }
      return existed;
    },

    /**
     * Clear all tools (per Chrome's WebMCP implementation)
     */
    clearContext() {
      const hadTools = tools.size > 0;
      tools.clear();
      if (hadTools) {
        queueMicrotask(() => events.dispatchEvent({ type: 'tools/listChanged' }));
      }
    }
  };

  /**
   * AGENT-SIDE API: navigator.modelContextTesting
   * For agents to discover and call tools registered by pages
   */
  const modelContextTesting = {
    /**
     * List all registered tools (agent-side)
     * Returns tool descriptors without execute functions
     */
    listTools() {
      return listToolsInternal();
    },

    /**
     * Execute a tool by name (agent-side)
     * Chrome's native API expects args as JSON string
     */
    async executeTool(name, args = '{}') {
      // Parse args if it's a JSON string (Chrome's native format)
      const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
      return executeToolInternal(name, parsedArgs);
    },

    /**
     * Register a callback for when tools change (agent-side)
     * Chrome's native API uses this pattern instead of addEventListener
     */
    registerToolsChangedCallback(callback) {
      if (typeof callback !== 'function') {
        throw new TypeError('Callback must be a function');
      }
      toolsChangedCallbacks.push(callback);
    }
  };

  // Make modelContextTesting look like Chrome's native implementation
  Object.defineProperty(modelContextTesting, Symbol.toStringTag, {
    value: 'ModelContextTesting',
    configurable: true
  });

  // Define navigator.modelContext (page-side API)
  Object.defineProperty(navigator, 'modelContext', {
    value: modelContext,
    writable: false,
    configurable: false,
    enumerable: true
  });

  // Define navigator.modelContextTesting (agent-side API)
  Object.defineProperty(navigator, 'modelContextTesting', {
    value: modelContextTesting,
    writable: false,
    configurable: false,
    enumerable: true
  });

  // Backward compatibility: window.agent combines both APIs for legacy scripts
  const agentCompat = {
    // Page-side methods
    provideContext: modelContext.provideContext.bind(modelContext),
    registerTool: modelContext.registerTool.bind(modelContext),
    unregisterTool: modelContext.unregisterTool.bind(modelContext),
    clearContext: modelContext.clearContext.bind(modelContext),
    // Agent-side methods (legacy support)
    listTools: modelContextTesting.listTools.bind(modelContextTesting),
    callTool: (name, args) => executeToolInternal(name, args), // Direct call, not JSON string
    // Legacy event API
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events)
  };

  Object.defineProperty(window, 'agent', {
    value: agentCompat,
    writable: false,
    configurable: false,
    enumerable: true
  });

  // Expose error classes on all APIs for consumers
  const errorClasses = {
    WebMCPError,
    ToolNotFoundError,
    ValidationError,
    ExecutionError
  };
  modelContext.errors = errorClasses;
  modelContextTesting.errors = errorClasses;
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

  console.log('[WebMCP] Polyfill ready: navigator.modelContext, navigator.modelContextTesting (also: window.agent)');
})();
