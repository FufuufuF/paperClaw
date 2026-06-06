export type JsonSchema = Record<string, unknown>;

const JSON_TYPE_NAMES = new Set(['string', 'integer', 'number', 'boolean', 'array', 'object']);
const TRUE_STRINGS = new Set(['true', '1', 'yes']);
const FALSE_STRINGS = new Set(['false', '0', 'no']);

export type ParsedToolArgs = {
  ok: true;
  args: Record<string, unknown>;
} | {
  ok: false;
  error: string;
  raw?: unknown;
};

export function parseToolArgs(input: string | Record<string, unknown>): ParsedToolArgs {
  if (typeof input !== 'string') {
    if (isRecord(input)) return { ok: true, args: input };
    return { ok: false, error: `tool args must be an object, got ${typeof input}`, raw: input };
  }

  const trimmed = input.trim();
  if (!trimmed) return { ok: true, args: {} };

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) {
      const kind = Array.isArray(parsed) ? 'array' : typeof parsed;
      return { ok: false, error: `tool args must be a JSON object, got ${kind}`, raw: input };
    }
    return { ok: true, args: parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `JSON parse error: ${message}`, raw: input };
  }
}

export function castParams(params: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
  if (resolveType(schema.type) !== 'object') return params;
  return castObject(params, schema);
}

export function validateParams(params: Record<string, unknown>, schema: JsonSchema): string[] {
  const objectSchema = { ...schema, type: 'object' };
  return validateJsonSchemaValue(params, objectSchema, '');
}

export function validateJsonSchemaValue(value: unknown, schema: JsonSchema, path: string): string[] {
  const type = resolveType(schema.type);
  const label = path || 'parameter';
  const nullable = schema.nullable === true || (Array.isArray(schema.type) && schema.type.includes('null'));
  if (value === null && nullable) return [];

  const typeError = validateType(value, type, label);
  if (typeError) return [typeError];

  const errors: string[] = [];
  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && !enumValues.includes(value)) {
    errors.push(`${label} must be one of ${JSON.stringify(enumValues)}`);
  }

  if ((type === 'integer' || type === 'number') && typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${label} must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${label} must be <= ${schema.maximum}`);
    }
  }

  if (type === 'string' && typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${label} must be at least ${schema.minLength} chars`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${label} must be at most ${schema.maxLength} chars`);
    }
  }

  if (type === 'object' && isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === 'string' && !(key in value)) {
        errors.push(`missing required ${subpath(path, key)}`);
      }
    }
    for (const [key, item] of Object.entries(value)) {
      const propSchema = properties[key];
      if (isRecord(propSchema)) {
        errors.push(...validateJsonSchemaValue(item, propSchema, subpath(path, key)));
      }
    }
  }

  if (type === 'array' && Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${label} must have at least ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${label} must have at most ${schema.maxItems} items`);
    }
    if (isRecord(schema.items)) {
      value.forEach((item, idx) => {
        errors.push(...validateJsonSchemaValue(item, schema.items as JsonSchema, `${label}[${idx}]`));
      });
    }
  }

  return errors;
}

function castObject(params: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    const propSchema = properties[key];
    out[key] = isRecord(propSchema) ? castValue(value, propSchema) : value;
  }
  return out;
}

function castValue(value: unknown, schema: JsonSchema): unknown {
  const type = resolveType(schema.type);
  if (value === null || value === undefined) return value;

  if ((type === 'integer' || type === 'number') && typeof value === 'string') {
    const parsed = type === 'integer' ? Number.parseInt(value, 10) : Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : value;
  }

  if (type === 'string') {
    return typeof value === 'string' ? value : String(value);
  }

  if (type === 'boolean' && typeof value === 'string') {
    const lower = value.toLowerCase();
    if (TRUE_STRINGS.has(lower)) return true;
    if (FALSE_STRINGS.has(lower)) return false;
    return value;
  }

  if (type === 'array' && Array.isArray(value) && isRecord(schema.items)) {
    return value.map((item) => castValue(item, schema.items as JsonSchema));
  }

  if (type === 'object' && isRecord(value)) {
    return castObject(value, schema);
  }

  return value;
}

function validateType(value: unknown, type: string | null, label: string): string | null {
  if (!type) return null;
  if (!JSON_TYPE_NAMES.has(type)) return null;
  if (type === 'integer') {
    return Number.isInteger(value) && typeof value === 'number' ? null : `${label} should be integer`;
  }
  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value) ? null : `${label} should be number`;
  }
  if (type === 'array') {
    return Array.isArray(value) ? null : `${label} should be array`;
  }
  if (type === 'object') {
    return isRecord(value) ? null : `${label} should be object`;
  }
  if (typeof value !== type) {
    return `${label} should be ${type}`;
  }
  return null;
}

function resolveType(type: unknown): string | null {
  if (Array.isArray(type)) {
    const found = type.find((item) => typeof item === 'string' && item !== 'null');
    return typeof found === 'string' ? found : null;
  }
  return typeof type === 'string' ? type : null;
}

function subpath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
