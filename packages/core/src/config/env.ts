import { isRecord } from './validation.js';

export function resolveEnvRefs<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === 'string') {
    return replaceEnvRefs(value, env) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveEnvRefs(item, env)) as T;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = resolveEnvRefs(item, env);
    }
    return out as T;
  }
  return value;
}

function replaceEnvRefs(input: string, env: NodeJS.ProcessEnv): string {
  return input.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
    const value = env[name];
    if (value === undefined) {
      throw new Error(`Environment variable "${name}" referenced in config is not set`);
    }
    return value;
  });
}
