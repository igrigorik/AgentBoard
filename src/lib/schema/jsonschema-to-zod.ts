import { z } from 'zod';

export type JSONSchemaLike = {
  type?: string;
  enum?: string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: unknown;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  anyOf?: unknown[];
  oneOf?: unknown[];
  description?: string;
};

export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.object({});
  const sch = schema as JSONSchemaLike;

  if (typeof (sch as unknown) === 'boolean') {
    return (sch as unknown as boolean) ? z.any() : z.never();
  }

  switch (sch.type) {
    case 'string': {
      let s = z.string();
      if (sch.enum) return z.enum(sch.enum as [string, ...string[]]);
      if (typeof sch.minLength === 'number') s = s.min(sch.minLength);
      if (typeof sch.maxLength === 'number') s = s.max(sch.maxLength);
      if (sch.description) s = s.describe(sch.description);
      return s;
    }
    case 'number':
    case 'integer': {
      let n = sch.type === 'integer' ? z.number().int() : z.number();
      if (typeof sch.minimum === 'number') n = n.min(sch.minimum);
      if (typeof sch.maximum === 'number') n = n.max(sch.maximum);
      return n;
    }
    case 'boolean':
      return z.boolean();
    case 'array': {
      const itemSchema = sch.items ? jsonSchemaToZod(sch.items) : z.any();
      let arr = z.array(itemSchema);
      if (typeof sch.minItems === 'number') arr = arr.min(sch.minItems);
      if (typeof sch.maxItems === 'number') arr = arr.max(sch.maxItems);
      return arr;
    }
    case 'object': {
      const shape: Record<string, z.ZodTypeAny> = {};
      const properties = (sch.properties || {}) as Record<string, unknown>;
      const required: string[] = Array.isArray(sch.required) ? sch.required : [];
      for (const [key, prop] of Object.entries(properties)) {
        const propZod = jsonSchemaToZod(prop);
        shape[key] = required.includes(key) ? propZod : propZod.optional();
      }
      let obj = z.object(shape);
      if (sch.additionalProperties === false) {
        try {
          const maybeCatchall = obj as unknown as {
            catchall?: (arg: z.ZodTypeAny) => z.ZodTypeAny;
          };
          const maybeStrict = obj as unknown as { strict?: () => z.ZodTypeAny };
          if (typeof maybeCatchall.catchall === 'function') {
            obj = maybeCatchall.catchall(z.never()) as unknown as typeof obj;
          }
          if (typeof maybeStrict.strict === 'function') {
            obj = maybeStrict.strict() as unknown as typeof obj;
          }
        } catch {
          // Best-effort; ignore if methods not present
        }
      }
      return obj;
    }
    default: {
      if (Array.isArray(sch.anyOf) && sch.anyOf.length > 0) {
        const variants = (sch.anyOf as unknown[]).map((v) => jsonSchemaToZod(v));
        return variants.length >= 2 ? z.union([variants[0], variants[1]]) : variants[0] || z.any();
      }
      if (Array.isArray(sch.oneOf) && sch.oneOf.length > 0) {
        const variants = (sch.oneOf as unknown[]).map((v) => jsonSchemaToZod(v));
        return variants.length >= 2 ? z.union([variants[0], variants[1]]) : variants[0] || z.any();
      }
      if (sch.properties && !sch.type) {
        const shape: Record<string, z.ZodTypeAny> = {};
        const required: string[] = Array.isArray(sch.required) ? sch.required : [];
        for (const [key, prop] of Object.entries(sch.properties as Record<string, unknown>)) {
          const propZod = jsonSchemaToZod(prop);
          shape[key] = required.includes(key) ? propZod : propZod.optional();
        }
        return z.object(shape);
      }
      return z.any();
    }
  }
}
