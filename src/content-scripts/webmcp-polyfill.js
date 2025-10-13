/**
 * WebMCP Polyfill - Complete implementation of WebMCP API
 * Provides tool registration and invocation capabilities for web agents
 *
 * Usage: Include this script before any code that uses window.agent
 */
(function () {
  'use strict';

  if ('agent' in window) {
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

  function createAgent() {
    const tools = new Map();
    const events = createEventTarget();

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

    const agent = {
      // Replace entire tool set
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

      // Append a single tool
      registerTool(rawTool) {
        const tool = validateAndNormalizeTool(rawTool);
        if (tools.has(tool.name)) {
          // Allow replacement for hot reload
          console.warn(`[WebMCP] Replacing existing tool: ${tool.name}`);
        }
        tools.set(tool.name, tool);
        queueMicrotask(() => events.dispatchEvent({ type: 'tools/listChanged' }));
      },

      // Invoke a tool
      async callTool(toolName, params = {}) {
        if (!tools.has(toolName)) {
          throw new ToolNotFoundError(toolName);
        }
        const tool = tools.get(toolName);
        try {
          validateParams(params, tool.inputSchema);
          return await Promise.resolve(tool.execute(params));
        } catch (err) {
          if (err instanceof ValidationError || err instanceof ExecutionError) throw err;
          throw new ExecutionError(`Tool '${toolName}' execution failed: ${err && err.message ? err.message : String(err)}`, err);
        }
      },

      // Discover tools
      listTools() {
        return Array.from(tools.values()).map(({ name, description, inputSchema }) => ({
          name, description, inputSchema
        }));
      },

      // Events
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events)
    };

    return agent;
  }

  // Initialize the agent
  window.agent = createAgent();
  window.agent.errors = {
    WebMCPError,
    ToolNotFoundError,
    ValidationError,
    ExecutionError
  };
})();