/**
 * Tool input schema passthrough
 *
 * Regression tests for the lossy JSON-Schema -> Zod -> JSON-Schema round-trip
 * that previously degraded WebMCP/MCP tool declarations before providers saw
 * them: descriptions on non-string properties were dropped, union types like
 * `type: ['string','number']` collapsed into typeless `{}` declarations, and
 * defaults disappeared. On Gemini this broke function calling outright (the
 * model leaked text-format pseudo tool calls with `<ctrl46>` tokens instead of
 * emitting native calls, observed with Shopify's storefront WebMCP tools).
 *
 * The contract under test: the exact JSON Schema a page or MCP server declares
 * is what the AI SDK hands to the provider adapter, via `asSchema(...)` — the
 * same resolution streamText performs when preparing tools.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asSchema } from 'ai';
import type { Tool as MCPTool } from '@modelcontextprotocol/sdk/types.js';

import { convertWebMCPToAISDKTool } from '../src/lib/webmcp/tool-bridge';
import { convertMCPToAISDKTool } from '../src/lib/mcp/tool-bridge';
import { normalizeToolInputSchema } from '../src/lib/schema/normalize-tool-input-schema';
import type { RemoteMCPSession, RemoteMCPToolCapability } from '../src/lib/mcp/manager';
import { getTabManager } from '../src/lib/webmcp/lifecycle';

vi.mock('../src/lib/webmcp/lifecycle', () => ({
  getTabManager: vi.fn(),
}));

vi.mock('../src/lib/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

/** Trimmed from Shopify WebMCP v0.1.0 `update_cart`: descriptions live on an
 *  array, a nested object, and an integer with a default — every spot the old
 *  Zod round-trip silently dropped. */
const updateCartSchema = {
  type: 'object',
  required: ['cart'],
  properties: {
    cart: {
      type: 'object',
      required: ['line_items'],
      properties: {
        line_items: {
          type: 'array',
          description: 'Items to add or update (1-10).',
          items: {
            type: 'object',
            properties: {
              item: {
                type: 'object',
                description: 'The merchandise to add.',
                properties: {
                  id: { type: 'string', description: 'ProductVariant GID.' },
                },
              },
              handle: { type: 'string', description: 'Product handle.' },
              quantity: {
                type: 'integer',
                description: 'Quantity. Defaults to 1. Set 0 to remove.',
                default: 1,
              },
            },
          },
        },
      },
    },
  },
};

/** Trimmed from Shopify WebMCP v0.1.0 `show_variant`: a union-typed property
 *  the old converter turned into a typeless `{}` declaration. */
const showVariantSchema = {
  type: 'object',
  required: ['catalog'],
  properties: {
    catalog: {
      type: 'object',
      description: 'Provide EITHER variant_id OR selected_options.',
      properties: {
        variant_id: {
          type: ['string', 'number'],
          description: 'ProductVariant GID or numeric variant ID.',
        },
      },
    },
  },
};

/** Resolve a converted tool's schema exactly as streamText hands it to a provider. */
function providerSchema(sdkTool: unknown) {
  return asSchema((sdkTool as { inputSchema: never }).inputSchema);
}

describe('normalizeToolInputSchema', () => {
  it('passes plain-object schemas through by reference', () => {
    expect(normalizeToolInputSchema(updateCartSchema)).toBe(updateCartSchema);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'not-a-schema'],
    ['a number', 7],
    ['an array', [{ type: 'object' }]],
  ])('declares "no parameters" when the schema is %s', (_label, malformed) => {
    expect(normalizeToolInputSchema(malformed)).toEqual({ type: 'object', properties: {} });
  });
});

describe('WebMCP tool schema passthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves descriptions on arrays, nested objects, and integers (update_cart regression)', () => {
    const sdkTool = convertWebMCPToAISDKTool(
      { name: 'update_cart', description: 'Update the cart', inputSchema: updateCartSchema },
      100
    );

    const schema = providerSchema(sdkTool).jsonSchema as typeof updateCartSchema;
    expect(schema).toEqual(updateCartSchema);

    // Explicit spot-checks on the fields the old converter dropped.
    const lineItems = schema.properties.cart.properties.line_items;
    expect(lineItems.description).toBe('Items to add or update (1-10).');
    expect(lineItems.items.properties.item.description).toBe('The merchandise to add.');
    expect(lineItems.items.properties.quantity.description).toBe(
      'Quantity. Defaults to 1. Set 0 to remove.'
    );
    expect(lineItems.items.properties.quantity.default).toBe(1);
    expect(schema.required).toEqual(['cart']);
  });

  it('preserves union types instead of declaring typeless properties (show_variant regression)', () => {
    const sdkTool = convertWebMCPToAISDKTool(
      { name: 'show_variant', description: 'Show a variant', inputSchema: showVariantSchema },
      100
    );

    const schema = providerSchema(sdkTool).jsonSchema as typeof showVariantSchema;
    const variantId = schema.properties.catalog.properties.variant_id;
    expect(variantId.type).toEqual(['string', 'number']);
    expect(variantId.description).toBe('ProductVariant GID or numeric variant ID.');
    expect(schema.properties.catalog.description).toBe(
      'Provide EITHER variant_id OR selected_options.'
    );
  });

  it('declares "no parameters" for tools without a usable schema', () => {
    for (const inputSchema of [undefined, 'garbage']) {
      const sdkTool = convertWebMCPToAISDKTool(
        { name: 'schemaless', description: 'No schema', inputSchema },
        100
      );
      expect(providerSchema(sdkTool).jsonSchema).toEqual({ type: 'object', properties: {} });
    }
  });

  it('leaves input validation to the page tool', () => {
    const sdkTool = convertWebMCPToAISDKTool(
      { name: 'update_cart', description: 'Update the cart', inputSchema: updateCartSchema },
      100
    );
    // No client-side validate function: the page tool owns argument validation,
    // matching MCP client norms.
    expect(providerSchema(sdkTool).validate).toBeUndefined();
  });

  it('passes model-generated arguments through to the page tool untouched', async () => {
    const callTool = vi.fn().mockResolvedValue('ok');
    const descriptor = { name: 'show_variant', inputSchema: showVariantSchema };
    vi.mocked(getTabManager).mockReturnValue({
      getToolRegistry: (tabId: number) => (tabId === 100 ? { tools: [descriptor] } : undefined),
      callTool,
    } as unknown as ReturnType<typeof getTabManager>);

    // A union-typed number and a key outside the schema both survive: the old
    // Zod pipeline could coerce or reject shapes the page tool accepts.
    const args = { catalog: { variant_id: 123, unlisted: 'kept' } };
    const sdkTool = convertWebMCPToAISDKTool(descriptor, 100) as unknown as {
      execute: (input: unknown) => Promise<unknown>;
    };
    await expect(sdkTool.execute(args)).resolves.toBe('ok');
    expect(callTool).toHaveBeenCalledWith(100, 'show_variant', args, undefined);
  });
});

describe('Remote MCP tool schema passthrough', () => {
  const executeTool = vi.fn();
  const session = { executeTool } as unknown as RemoteMCPSession;

  function capabilityFor(inputSchema: unknown): RemoteMCPToolCapability {
    return {
      serverName: 'server',
      tool: { name: 'remote_tool', description: 'Remote tool', inputSchema } as MCPTool,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hands the server-declared JSON Schema to the provider verbatim', () => {
    const sdkTool = convertMCPToAISDKTool(session, capabilityFor(updateCartSchema));
    const schema = providerSchema(sdkTool);
    expect(schema.jsonSchema).toEqual(updateCartSchema);
    expect(schema.validate).toBeUndefined();
  });

  it('declares "no parameters" when the server omits a schema', () => {
    const sdkTool = convertMCPToAISDKTool(session, capabilityFor(undefined));
    expect(providerSchema(sdkTool).jsonSchema).toEqual({ type: 'object', properties: {} });
  });

  it('coerces non-object arguments to an empty object for the MCP protocol', async () => {
    executeTool.mockResolvedValue({ isError: false, content: [{ type: 'text', text: 'done' }] });
    const sdkTool = convertMCPToAISDKTool(session, capabilityFor(updateCartSchema)) as unknown as {
      execute: (input: unknown) => Promise<unknown>;
    };

    await expect(sdkTool.execute(undefined)).resolves.toBe('done');
    expect(executeTool).toHaveBeenLastCalledWith(capabilityFor(updateCartSchema), {}, undefined);

    const args = { cart: { line_items: [{ handle: 'verticalboard-first', quantity: 1 }] } };
    await expect(sdkTool.execute(args)).resolves.toBe('done');
    expect(executeTool).toHaveBeenLastCalledWith(capabilityFor(updateCartSchema), args, undefined);
  });
});
