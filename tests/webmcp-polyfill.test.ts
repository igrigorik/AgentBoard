/**
 * Tests for WebMCP Polyfill (window.agent API)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
// @ts-ignore - jsdom types not installed
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';

describe('WebMCP Polyfill - JSON Schema Validation', () => {
  let dom: JSDOM;
  let window: Window & typeof globalThis;
  let agent: any;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'https://example.com',
      runScripts: 'dangerously',
    });

    window = dom.window as any;
    global.window = window as any;

    // Load the polyfill
    const polyfillCode = fs.readFileSync(
      path.join(__dirname, '../src/content-scripts/webmcp-polyfill.js'),
      'utf8'
    );

    const script = dom.window.document.createElement('script');
    script.textContent = polyfillCode;
    dom.window.document.body.appendChild(script);

    agent = (window as any).agent;
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
      await agent.callTool('test', {
        name: 'John Doe',
        age: 30,
        active: true,
      });

      // Missing required field - should fail
      await expectValidationError(
        () => agent.callTool('test', { age: 30, active: true }),
        ['name: required field missing']
      );

      // Wrong type - should fail
      await expectValidationError(
        () => agent.callTool('test', { name: 123, age: 30 }),
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
      await agent.callTool('test', {
        count: 5,
        price: 19.99,
      });

      // Float for integer field - should fail
      await expectValidationError(
        () => agent.callTool('test', { count: 5.5, price: 19.99 }),
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
      await agent.callTool('test', {
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
          agent.callTool('test', {
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
          agent.callTool('test', {
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
      await agent.callTool('test', {
        tags: ['javascript', 'typescript', 'react'],
        scores: [95, 87, 92],
      });

      // Wrong item type - should fail with index
      await expectValidationError(
        () =>
          agent.callTool('test', {
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
      await agent.callTool('test', {
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
          agent.callTool('test', {
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
          agent.callTool('test', {
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
      await agent.callTool('test', {
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
          agent.callTool('test', {
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
      await agent.callTool('test', {
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
          agent.callTool('test', {
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
      await agent.callTool('shopify_update_cart', {
        add_items: [
          {
            product_id: 'gid://shopify/ProductVariant/30674260033616',
            quantity: 1,
          },
        ],
      });

      // Complex valid params - should pass
      await agent.callTool('shopify_update_cart', {
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
          agent.callTool('shopify_update_cart', {
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
        await agent.callTool('test', {
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
