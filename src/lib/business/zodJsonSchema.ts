// Minimal zod (v3) → JSON Schema for the shapes business engines use, so a
// model is shown the SAME field names and limits the parser enforces.
// Covers object, array, string, number, boolean, enum, literal, nullable,
// optional, default and effects. Anything else becomes an open schema.

import type { ZodTypeAny } from "zod";

type Json = Record<string, unknown>;

export function zodToJsonSchema(schema: ZodTypeAny): Json {
  const def = (schema as unknown as { _def: Record<string, unknown> & { typeName: string } })._def;
  switch (def.typeName) {
    case "ZodObject": {
      const shape = (schema as unknown as { shape: Record<string, ZodTypeAny> }).shape;
      const properties: Record<string, Json> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(child);
        if (!child.isOptional()) required.push(key);
      }
      return { type: "object", properties, required };
    }
    case "ZodArray": {
      const out: Json = { type: "array", items: zodToJsonSchema(def.type as ZodTypeAny) };
      const max = (def.maxLength as { value: number } | null)?.value;
      const min = (def.minLength as { value: number } | null)?.value;
      if (max !== undefined) out.maxItems = max;
      if (min !== undefined) out.minItems = min;
      return out;
    }
    case "ZodString": {
      const out: Json = { type: "string" };
      for (const c of (def.checks as { kind: string; value?: number }[]) ?? []) {
        if (c.kind === "max") out.maxLength = c.value;
        if (c.kind === "min") out.minLength = c.value;
      }
      return out;
    }
    case "ZodNumber": {
      const out: Json = { type: (def.checks as { kind: string }[] | undefined)?.some((c) => c.kind === "int") ? "integer" : "number" };
      for (const c of (def.checks as { kind: string; value?: number }[]) ?? []) {
        if (c.kind === "max") out.maximum = c.value;
        if (c.kind === "min") out.minimum = c.value;
      }
      return out;
    }
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return { type: "string", enum: def.values as string[] };
    case "ZodLiteral":
      return { const: def.value };
    case "ZodNullable": {
      const inner = zodToJsonSchema(def.innerType as ZodTypeAny);
      return typeof inner.type === "string" ? { ...inner, type: [inner.type, "null"] } : { anyOf: [inner, { type: "null" }] };
    }
    case "ZodOptional":
    case "ZodDefault":
      return zodToJsonSchema(def.innerType as ZodTypeAny);
    case "ZodEffects":
      return zodToJsonSchema(def.schema as ZodTypeAny);
    default:
      return {};
  }
}
