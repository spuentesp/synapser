// Minimal JSON-Schema subset validator for tool arguments (no dependencies). Tool arguments come
// from a model, so they are validated BEFORE anything reaches the executor (plan 06 §6).
// Supported: type (object|array|string|integer|boolean), properties, required,
// additionalProperties:false, items, enum, minItems, maxItems, minLength, maxLength.

export interface Schema {
  type?: "object" | "array" | "string" | "integer" | "boolean";
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: readonly (string | number)[];
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

export function validate(value: unknown, schema: Schema, path = "$"): string[] {
  const errs: string[] = [];
  const t = schema.type;
  if (t === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${path}: expected object`];
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in obj)) errs.push(`${path}.${r}: required`);
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k];
      if (sub) errs.push(...validate(v, sub, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}.${k}: unexpected property`);
    }
  } else if (t === "array") {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path}: needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path}: at most ${schema.maxItems} item(s)`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(v, schema.items as Schema, `${path}[${i}]`)));
  } else if (t === "string") {
    if (typeof value !== "string") return [`${path}: expected string`];
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${path}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${path}: too long`);
  } else if (t === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) return [`${path}: expected integer`];
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: must be at most ${schema.maximum}`);
  } else if (t === "boolean") {
    if (typeof value !== "boolean") return [`${path}: expected boolean`];
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) errs.push(`${path}: must be one of ${schema.enum.join(", ")}`);
  return errs;
}
