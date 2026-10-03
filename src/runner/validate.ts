/** Minimal JSON-schema validator: enough for job output contracts. */

export interface Schema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  additionalProperties?: boolean;
  minItems?: number;
  maxItems?: number;
  maxLength?: number;
  pattern?: string;
}

const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

export function validate(value: unknown, schema: Schema, path = "$"): string[] {
  const errs: string[] = [];
  const k = kind(value);
  if (schema.type) {
    const ok = schema.type === "integer" ? Number.isInteger(value) : k === schema.type;
    if (!ok) return [`${path}: expected ${schema.type}, got ${k}`];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errs.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }
  if (typeof value === "string") {
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${path}: longer than ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path}: needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path}: at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(v, schema.items!, `${path}[${i}]`)));
  }
  if (k === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) errs.push(`${path}.${key}: required`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) errs.push(...validate(obj[key], sub, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) if (!schema.properties || !(key in schema.properties)) errs.push(`${path}.${key}: unexpected property`);
    }
  }
  return errs;
}
