import { assertBoolean, assertPositiveInt, asRecord } from '../../config/validation.js';

export interface ToolsConfig {
  maxResultChars: number;
  restrictToWorkspace: boolean;
}

export const DEFAULT_TOOLS_CONFIG: ToolsConfig = {
  maxResultChars: 16000,
  restrictToWorkspace: false,
};

export function parseToolsConfig(value: unknown, path = 'tools'): ToolsConfig {
  const cfg = asRecord(value, path) as unknown as ToolsConfig;
  assertPositiveInt(cfg.maxResultChars, `${path}.maxResultChars`);
  assertBoolean(cfg.restrictToWorkspace, `${path}.restrictToWorkspace`);
  return cfg;
}
