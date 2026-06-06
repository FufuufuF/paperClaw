export function assertLiteral(value: unknown, expected: unknown, path: string): void {
  if (value !== expected) {
    throw new Error(`${path} must be ${JSON.stringify(expected)}`);
  }
}

export function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
}

export function assertOptionalString(value: unknown, path: string): asserts value is string | undefined {
  if (value !== undefined) assertString(value, path);
}

export function assertPositiveInt(value: unknown, path: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${path} must be a positive integer`);
  }
}

export function assertNonNegativeInt(value: unknown, path: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
}

export function assertNumberInRange(
  value: unknown,
  min: number,
  max: number,
  path: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${path} must be a number between ${min} and ${max}`);
  }
}

export function assertBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${path} must be a boolean`);
  }
}

export function assertStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  for (const [idx, item] of value.entries()) {
    assertString(item, `${path}[${idx}]`);
  }
}

export function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
