import { assertNonNegativeInt, assertPositiveInt, assertString, asRecord } from '../config/validation.js';

export interface SessionConfig {
  dir: string;
  maxMessages: number;
  ttlMinutes: number;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  dir: 'output/sessions',
  maxMessages: 120,
  ttlMinutes: 0,
};

export function parseSessionConfig(value: unknown, path = 'session'): SessionConfig {
  const cfg = asRecord(value, path) as unknown as SessionConfig;
  assertString(cfg.dir, `${path}.dir`);
  assertPositiveInt(cfg.maxMessages, `${path}.maxMessages`);
  assertNonNegativeInt(cfg.ttlMinutes, `${path}.ttlMinutes`);
  return cfg;
}
