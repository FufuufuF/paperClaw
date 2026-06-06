import { isRecord } from './validation.js';

export function mergeConfig<T>(base: T, override: Record<string, unknown>): T {
  if (!isRecord(base)) return (override as T) ?? base;

  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const previous = out[key];
    if (isRecord(previous) && isRecord(value)) {
      out[key] = mergeConfig(previous, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}
