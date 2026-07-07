/**
 * Tests for WebMCP Polyfill
 *
 * Matches the current WebMCP shape (Chrome 150+): a single unified API on
 * document.modelContext (mirrored on navigator.modelContext). There is no more
 * navigator.modelContextTesting — discovery/execution live on modelContext:
 *   - registerTool(tool, { signal })           page-side; AbortSignal unregisters
 *   - getTools()                               agent-side discovery (async)
 *   - executeTool(tool, argsJson)              agent-side execution (async)
 *   - 'toolchange' event                       via addEventListener
 * window.agent remains as a thin legacy alias for AgentBoard's injected tools.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
// @ts-ignore - jsdom types not installed
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';

const polyfillCode = fs.readFileSync(
  path.join(__dirname, '../src/content-scripts/webmcp-polyfill.js'),
  'utf8'
);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Load the polyfill into a fresh JSDOM window. The polyfill defers registration to
 * DOMContentLoaded (it runs at document_start in prod), so we dispatch that event.
 */
function loadPolyfill() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://example.com',
    runScripts: 'dangerously',
  });

  const window = dom.window as any;
  global.window = window as any;

  const script = dom.window.document.createElement('script');
  script.textContent = polyfillCode;
  dom.window.document.body.appendChild(script);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));

  return {
    dom,
    window,
    modelContext: window.document.modelContext,
    agent: window.agent,
  };
}

describe('WebMCP Polyfill - API Location', () => {
  let window: any;
  let modelContext: any;
  let agent: any;

  beforeEach(() => {
    ({ window, modelContext, agent } = loadPolyfill());
  });

  it('should expose document.modelContext with the unified API', () => {
    expect(window.document.modelContext).toBeDefined();
    expect(typeof modelContext.registerTool).toBe('function');
    expect(typeof modelContext.getTools).toBe('function');
    expect(typeof modelContext.executeTool).toBe('function');
    // EventTarget surface for 'toolchange'
    expect(typeof modelContext.addEventListener).toBe('function');
  });

  it('should mirror modelContext on navigator (deprecated alias)', () => {
    expect(window.navigator.modelContext).toBe(window.document.modelContext);
  });

  it('should NOT expose navigator.modelContextTesting (removed in current spec)', () => {
    expect(window.navigator.modelContextTesting).toBeUndefined();
  });

  it('should expose window.agent as a thin legacy alias', () => {
    expect(agent).toBeDefined();
    expect(typeof agent.registerTool).toBe('function');
    expect(typeof agent.getTools).toBe('function');
    expect(typeof agent.executeTool).toBe('function');
  });
});

describe('WebMCP Polyfill - registerTool & getTools', () => {
  let modelContext: any;

  beforeEach(() => {
    ({ modelContext } = loadPolyfill());
  });

  it('should register a tool discoverable via getTools()', async () => {
    modelContext.registerTool({
      name: 'test_tool',
      description: 'Test tool',
      inputSchema: { type: 'object', properties: {} },
      execute: vi.fn(),
    });

    const tools = await modelContext.getTools();
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('test_tool');
  });

  it('getTools() should serialize inputSchema as a JSON string and include origin (native shape)', async () => {
    const schema = { type: 'object', properties: { input: { type: 'string' } } };
    modelContext.registerTool({
      name: 'schema_tool',
      description: 'Has schema',
      inputSchema: schema,
      execute: vi.fn(),
    });

    const [tool] = await modelContext.getTools();
    expect(typeof tool.inputSchema).toBe('string');
    expect(JSON.parse(tool.inputSchema)).toEqual(schema);
    expect(tool.origin).toBe('https://example.com');
    // execute is not exposed to agents
    expect(tool.execute).toBeUndefined();
  });

  it('getTools() should return tools sorted alphabetically by name', async () => {
    modelContext.registerTool({ name: 'zebra', description: 'z', execute: vi.fn() });
    modelContext.registerTool({ name: 'apple', description: 'a', execute: vi.fn() });
    modelContext.registerTool({ name: 'mango', description: 'm', execute: vi.fn() });

    const names = (await modelContext.getTools()).map((t: any) => t.name);
    expect(names).toEqual(['apple', 'mango', 'zebra']);
  });

  it('registering a tool with an existing name should replace it', async () => {
    modelContext.registerTool({ name: 'dup', description: 'one', execute: vi.fn() });
    modelContext.registerTool({ name: 'dup', description: 'two', execute: vi.fn() });

    const tools = await modelContext.getTools();
    expect(tools.length).toBe(1);
    expect(tools[0].description).toBe('two');
  });

  it('registerTool should reject invalid tools', () => {
    expect(() => modelContext.registerTool({ description: 'no name', execute: vi.fn() })).toThrow(
      /string name/
    );
    expect(() => modelContext.registerTool({ name: 'x', execute: vi.fn() })).toThrow(
      /string description/
    );
    expect(() => modelContext.registerTool({ name: 'x', description: 'd' })).toThrow(
      /execute function/
    );
  });
});

describe('WebMCP Polyfill - AbortSignal unregistration', () => {
  let window: any;
  let modelContext: any;

  beforeEach(() => {
    ({ window, modelContext } = loadPolyfill());
  });

  it('should unregister a tool when its AbortSignal fires', async () => {
    const controller = new window.AbortController();
    modelContext.registerTool(
      { name: 'abortable', description: 'd', execute: vi.fn() },
      { signal: controller.signal }
    );
    expect((await modelContext.getTools()).length).toBe(1);

    controller.abort();
    expect((await modelContext.getTools()).length).toBe(0);
  });

  it('should not register a tool whose signal is already aborted', async () => {
    const controller = new window.AbortController();
    controller.abort();
    modelContext.registerTool(
      { name: 'dead', description: 'd', execute: vi.fn() },
      { signal: controller.signal }
    );
    expect((await modelContext.getTools()).length).toBe(0);
  });

  it('should fire toolchange when a signal unregisters a tool', async () => {
    const controller = new window.AbortController();
    modelContext.registerTool(
      { name: 'abortable', description: 'd', execute: vi.fn() },
      { signal: controller.signal }
    );
    await tick();

    const callback = vi.fn();
    modelContext.addEventListener('toolchange', callback);
    controller.abort();
    await tick();

    expect(callback).toHaveBeenCalled();
  });
});

describe('WebMCP Polyfill - toolchange event', () => {
  let modelContext: any;

  beforeEach(() => {
    ({ modelContext } = loadPolyfill());
  });

  it('should fire toolchange when a tool is registered', async () => {
    const callback = vi.fn();
    modelContext.addEventListener('toolchange', callback);

    modelContext.registerTool({ name: 'test_tool', description: 'd', execute: vi.fn() });
    await tick();

    expect(callback).toHaveBeenCalled();
  });

  it('should stop firing after removeEventListener', async () => {
    const callback = vi.fn();
    modelContext.addEventListener('toolchange', callback);
    modelContext.removeEventListener('toolchange', callback);

    modelContext.registerTool({ name: 'test_tool', description: 'd', execute: vi.fn() });
    await tick();

    expect(callback).not.toHaveBeenCalled();
  });

  it('should coalesce a burst of synchronous registrations into notifications', async () => {
    const callback = vi.fn();
    modelContext.addEventListener('toolchange', callback);

    modelContext.registerTool({ name: 'a', description: 'd', execute: vi.fn() });
    modelContext.registerTool({ name: 'b', description: 'd', execute: vi.fn() });
    await tick();

    expect(callback).toHaveBeenCalled();
    expect((await modelContext.getTools()).length).toBe(2);
  });
});

describe('WebMCP Polyfill - executeTool', () => {
  let modelContext: any;

  beforeEach(() => {
    ({ modelContext } = loadPolyfill());
  });

  it('should execute a tool by tool object with JSON-string args (native shape)', async () => {
    const executeFn = vi.fn().mockResolvedValue('result');
    modelContext.registerTool({
      name: 'test_tool',
      description: 'd',
      inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
      execute: executeFn,
    });

    const [tool] = await modelContext.getTools();
    const result = await modelContext.executeTool(tool, '{"input":"hello"}');
    expect(result).toBe('result');
    expect(executeFn).toHaveBeenCalledWith({ input: 'hello' }, expect.any(Object));
  });

  it('should also accept a bare tool name and object args (convenience)', async () => {
    const executeFn = vi.fn().mockResolvedValue('result');
    modelContext.registerTool({
      name: 'test_tool',
      description: 'd',
      inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
      execute: executeFn,
    });

    const result = await modelContext.executeTool('test_tool', { input: 'hello' });
    expect(result).toBe('result');
    expect(executeFn).toHaveBeenCalledWith({ input: 'hello' }, expect.any(Object));
  });

  it('should reject for unknown tools', async () => {
    await expect(modelContext.executeTool('nope', '{}')).rejects.toThrow(/not found/);
  });
});

describe('WebMCP Polyfill - agent context in execute', () => {
  let modelContext: any;

  beforeEach(() => {
    ({ modelContext } = loadPolyfill());
  });

  it('should pass agent context with requestUserInteraction to execute', async () => {
    let receivedAgent: any = null;

    modelContext.registerTool({
      name: 'test_tool',
      description: 'd',
      inputSchema: { type: 'object', properties: {} },
      execute: (_args: any, agent: any) => {
        receivedAgent = agent;
        return { success: true };
      },
    });

    await modelContext.executeTool('test_tool', '{}');

    expect(receivedAgent).toBeDefined();
    expect(typeof receivedAgent.requestUserInteraction).toBe('function');
  });

  it('should execute requestUserInteraction callback', async () => {
    let interactionCalled = false;

    modelContext.registerTool({
      name: 'test_tool',
      description: 'd',
      inputSchema: { type: 'object', properties: {} },
      execute: async (_args: any, agent: any) => {
        const result = await agent.requestUserInteraction(async () => {
          interactionCalled = true;
          return 'user_confirmed';
        });
        return { result };
      },
    });

    const result = await modelContext.executeTool('test_tool', '{}');

    expect(interactionCalled).toBe(true);
    expect(result.result).toBe('user_confirmed');
  });
});

describe('WebMCP Polyfill - annotations', () => {
  let modelContext: any;

  beforeEach(() => {
    ({ modelContext } = loadPolyfill());
  });

  it('registerTool with annotations — survives round-trip via getTools', async () => {
    modelContext.registerTool({
      name: 'annotated_tool',
      description: 'Tool with annotations',
      inputSchema: { type: 'object', properties: {} },
      execute: vi.fn(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    });

    const tools = await modelContext.getTools();
    expect(tools.length).toBe(1);
    expect(tools[0].annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
  });

  it('tool without annotations — getTools omits the field entirely', async () => {
    modelContext.registerTool({
      name: 'plain_tool',
      description: 'No annotations',
      inputSchema: { type: 'object', properties: {} },
      execute: vi.fn(),
    });

    const [tool] = await modelContext.getTools();
    expect(tool).not.toHaveProperty('annotations');
  });
});

describe('WebMCP Polyfill - JSON Schema Validation', () => {
  let agent: any;

  beforeEach(() => {
    ({ agent } = loadPolyfill());
  });

  // Helper to check validation errors
  async function expectValidationError(fn: () => Promise<any>, expectedErrors: string[]) {
    try {
      await fn();
      expect.fail('Should have thrown ValidationError');
    } catch (error: any) {
      expect(error.name).toBe('ValidationError');
      expect(error.errors).toBeDefined();
      for (const expectedError of expectedErrors) {
        const found = error.errors.some((e: string) => e.includes(expectedError));
        if (!found) {
          console.log('Actual errors:', error.errors);
          expect.fail(`Expected error containing "${expectedError}" but not found in errors`);
        }
      }
    }
  }

  describe('Basic Types', () => {
    it('should validate primitive types correctly', async () => {
      const tool = {
        name: 'test',
        description: 'Test tool',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'number' },
            active: { type: 'boolean' },
          },
          required: ['name'],
        },
        execute: vi.fn(),
      };

      agent.registerTool(tool);

      // Valid params - should pass
      await agent.executeTool('test', {
        name: 'John Doe',
        age: 30,
        active: true,
      });

      // Missing required field - should fail
      await expectValidationError(
        () => agent.executeTool('test', { age: 30, active: true }),
        ['name: required field missing']
      );

      // Wrong type - should fail
      await expectValidationError(
        () => agent.executeTool('test', { name: 123, age: 30 }),
        ['name: expected string, got number']
      );
    });

    it('should validate integer vs number correctly', async () => {
      const tool = {
        name: 'test',
        description: 'Test tool',
        inputSchema: {
          type: 'object',
          properties: {
            count: { type: 'integer' },
            price: { type: 'number' },
          },
        },
        execute: vi.fn(),
      };

      agent.registerTool(tool);

      // Valid integers and numbers
      await agent.executeTool('test', {
        count: 5,
        price: 19.99,
      });

      // Float for integer field - should fail
      await expectValidationError(
        () => agent.executeTool('test', { count: 5.5, price: 19.99 }),
        ['count: expected integer']
      );
    });
  });

  describe('Nested Objects', () => {
    it('should validate nested objects recursively', async () => {
      const tool = {
        name: 'test',
        description: 'Test tool',
        inputSchema: {
          type: 'object',
          properties: {
            user: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                email: { type: 'string' },
                profile: {
                  type: 'object',
                  properties: {
                    bio: { type: 'string' },
                    avatar: { type: 'string' },
                  },
                  required: ['bio'],
                },
              },
              required: ['name', 'email'],
            },
          },
          required: ['user'],
        },
        execute: vi.fn(),
      };

      agent.registerTool(tool);

      // Valid nested object - should pass
      await agent.executeTool('test', {
        user: {
          name: 'Jane Smith',
          email: 'jane@example.com',
          profile: {
            bio: 'Software Engineer',
            avatar: 'avatar.jpg',
          },
        },
      });

      // Missing nested required field - should fail with path
      await expectValidationError(
        () =>
          agent.executeTool('test', {
            user: {
              name: 'Jane Smith',
              // Missing email
              profile: {
                bio: 'Software Engineer',
              },
            },
          }),
        ['user.email: required field missing']
      );

      // Missing deeply nested required field - should fail with full path
      await expectValidationError(
        () =>
          agent.executeTool('test', {
            user: {
              name: 'Jane Smith',
              email: 'jane@example.com',
              profile: {
                // Missing bio
                avatar: 'avatar.jpg',
              },
            },
          }),
        ['user.profile.bio: required field missing']
      );
    });
  });

  describe('Arrays', () => {
    it('should validate arrays of primitives', async () => {
      const tool = {
        name: 'test',
        description: 'Test tool',
        inputSchema: {
          type: 'object',
          properties: {
            tags: {
              type: 'array',
              items: { type: 'string' },
            },
            scores: {
              type: 'array',
              items: { type: 'number' },
            },
          },
        },
        execute: vi.fn(),
      };

      agent.registerTool(tool);

      // Valid arrays - should pass
      await agent.executeTool('test', {
        tags: ['javascript', 'typescript', 'react'],
        scores: [95, 87, 92],
      });

      // Wrong item type - should fail with index
      await expectValidationError(
        () =>
          agent.executeTool('test', {
            tags: ['javascript', 123, 'react'],
            scores: [95, 87, 92],
          }),
        ['tags[1]: expected string, got number']
      );
    });

    it('should validate arrays of objects (Shopify-style)', async () => {
      const tool = {
        name: 'test',
        description: 'Test tool',
        inputSchema: {
          type: 'object',
          properties: {
            add_items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  product_id: { type: 'string' },
                  quantity: { type: 'integer' },
                },
                required: ['product_id', 'quantity'],
              },
            },
          },
          required: ['add_items'],
        },
        execute: vi.fn(),
      };

      agent.registerTool(tool);

      // Valid array of objects - should pass
      await agent.executeTool('test', {
        add_items: [
          {
            product_id: 'gid://shopify/ProductVariant/123',
            quantity: 2,
          },
          {
            product_id: 'gid://shopify/ProductVariant/456',
            quantity: 1,
          },
        ],
      });

      // Wrong type in array item - should fail with path
      await expectValidationError(
        () =>
          agent.executeTool('test', {
            add_items: [
              {
                product_id: 'gid://shopify/ProductVariant/123',
                quantity: '2', // String instead of integer
              },
            ],
          }),
        ['add_items[0].quantity: expected integer, got string']
      );

      // Missing required field in array item - should fail with path
      await expectValidationError(
        () =>
          agent.executeTool('test', {
            add_items: [
              {
                product_id: 'gid://shopify/ProductVariant/123',
                // Missing quantity
              },
            ],
          }),
        ['add_items[0].quantity: required field missing']
      );
    });

    it('should handle deeply nested arrays and objects', async () => {
      const tool = {
        name: 'test',
        description: 'Test tool',
        inputSchema: {
          type: 'object',
          properties: {
            company: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                departments: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      employees: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            name: { type: 'string' },
                            skills: {
                              type: 'array',
                              items: { type: 'string' },
                            },
                          },
                          required: ['id', 'name'],
                        },
                      },
                    },
                    required: ['name', 'employees'],
                  },
                },
              },
              required: ['name', 'departments'],
            },
          },
          required: ['company'],
        },
        execute: vi.fn(),
      };

      agent.registerTool(tool);

      // Valid deeply nested structure - should pass
      await agent.executeTool('test', {
        company: {
          name: 'TechCorp',
          departments: [
            {
              name: 'Engineering',
              employees: [
                {
                  id: 'emp001',
                  name: 'Alice',
                  skills: ['Python', 'JavaScript'],
                },
                {
                  id: 'emp002',
                  name: 'Bob',
                  skills: [], // Empty array is valid
                },
              ],
            },
            {
              name: 'Marketing',
              employees: [], // Empty array is valid
            },
          ],
        },
      });

      // Missing deeply nested field - should fail with full path
      await expectValidationError(
        () =>
          agent.executeTool('test', {
            company: {
              name: 'TechCorp',
              departments: [
                {
                  name: 'Engineering',
                  employees: [
                    {
                      id: 'emp001',
                      // Missing name
                      skills: ['Python'],
                    },
                  ],
                },
              ],
            },
          }),
        ['company.departments[0].employees[0].name: required field missing']
      );
    });
  });

  describe('Additional Properties', () => {
    it('should allow additional properties by default', async () => {
      const tool = {
        name: 'test',
        description: 'Test tool',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
          // No additionalProperties specified - should allow extras
        },
        execute: vi.fn(),
      };

      agent.registerTool(tool);

      // Extra properties should be allowed
      await agent.executeTool('test', {
        name: 'John',
        extra: 'field',
        another: 123,
      });
    });

    it('should reject additional properties when set to false', async () => {
      const tool = {
        name: 'test',
        description: 'Test tool',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
          additionalProperties: false,
        },
        execute: vi.fn(),
      };

      agent.registerTool(tool);

      // Extra properties should be rejected
      await expectValidationError(
        () =>
          agent.executeTool('test', {
            name: 'John',
            extra: 'field',
          }),
        ['extra: additional property not allowed']
      );
    });
  });

  describe('Real-world Schemas', () => {
    it('should validate Shopify update_cart schema', async () => {
      const tool = {
        name: 'shopify_update_cart',
        description: 'Update cart',
        inputSchema: {
          type: 'object',
          properties: {
            cart_id: { type: 'string' },
            add_items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  product_id: { type: 'string' },
                  quantity: { type: 'integer' },
                  attributes: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        key: { type: 'string' },
                        value: { type: 'string' },
                      },
                      required: ['key', 'value'],
                    },
                  },
                },
                required: ['product_id', 'quantity'],
              },
            },
            buyer_identity: {
              type: 'object',
              properties: {
                email: { type: 'string' },
                phone: { type: 'string' },
                delivery_address: {
                  type: 'object',
                  properties: {
                    address1: { type: 'string' },
                    city: { type: 'string' },
                    country_code: { type: 'string' },
                  },
                  required: ['address1', 'city', 'country_code'],
                },
              },
            },
          },
          // No top-level required fields for update operations
        },
        execute: vi.fn(),
      };

      agent.registerTool(tool);

      // Valid Shopify params - should pass
      await agent.executeTool('shopify_update_cart', {
        add_items: [
          {
            product_id: 'gid://shopify/ProductVariant/30674260033616',
            quantity: 1,
          },
        ],
      });

      // Complex valid params - should pass
      await agent.executeTool('shopify_update_cart', {
        cart_id: 'cart123',
        add_items: [
          {
            product_id: 'gid://shopify/ProductVariant/123',
            quantity: 2,
            attributes: [
              { key: 'gift_wrap', value: 'yes' },
              { key: 'note', value: 'Happy Birthday!' },
            ],
          },
        ],
        buyer_identity: {
          email: 'customer@example.com',
          delivery_address: {
            address1: '123 Main St',
            city: 'New York',
            country_code: 'US',
          },
        },
      });

      // Missing required nested field - should fail with path
      await expectValidationError(
        () =>
          agent.executeTool('shopify_update_cart', {
            buyer_identity: {
              delivery_address: {
                address1: '123 Main St',
                // Missing city
                country_code: 'US',
              },
            },
          }),
        ['buyer_identity.delivery_address.city: required field missing']
      );
    });
  });

  describe('Error Messages', () => {
    it('should provide clear error paths for all validation failures', async () => {
      const tool = {
        name: 'test',
        description: 'Test tool',
        inputSchema: {
          type: 'object',
          properties: {
            users: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  age: { type: 'integer' },
                },
                required: ['name'],
              },
            },
          },
          required: ['users'],
        },
        execute: vi.fn(),
      };

      agent.registerTool(tool);

      try {
        await agent.executeTool('test', {
          users: [
            { name: 'Alice', age: 30 },
            { age: 'twenty-five' }, // Missing name, wrong type
            { name: 123, age: 40 }, // Wrong name type
          ],
        });
        expect.fail('Should have thrown validation error');
      } catch (error: any) {
        expect(error.name).toBe('ValidationError');
        expect(error.errors).toContain('users[1].name: required field missing');
        expect(error.errors).toContain('users[1].age: expected integer, got string');
        expect(error.errors).toContain('users[2].name: expected string, got number');
      }
    });
  });
});
