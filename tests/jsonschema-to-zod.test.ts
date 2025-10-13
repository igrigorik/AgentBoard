import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { jsonSchemaToZod } from '../src/lib/schema/jsonschema-to-zod';

describe('jsonSchemaToZod converter', () => {
  it('handles nested required array items (add_items[].product_variant_id)', () => {
    const schema = {
      type: 'object',
      properties: {
        add_items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['product_variant_id', 'quantity'],
            properties: {
              product_variant_id: { type: 'string' },
              quantity: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
    } as const;

    const zodSchema = jsonSchemaToZod(schema);
    const parse = (val: unknown) => (zodSchema as z.ZodTypeAny).safeParse(val);

    // Missing required field should fail
    const bad = parse({ add_items: [{ quantity: 1 }] });
    expect(bad.success).toBe(false);

    // Correct shape should pass
    const good = parse({
      add_items: [{ product_variant_id: 'gid://shopify/ProductVariant/123', quantity: 1 }],
    });
    expect(good.success).toBe(true);
  });
});
