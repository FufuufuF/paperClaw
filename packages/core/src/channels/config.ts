import { assertBoolean, assertNonNegativeInt, asRecord } from '../config/validation.js';

export interface ChannelsConfig {
  sendProgress: boolean;
  sendToolHints: boolean;
  showReasoning: boolean;
  sendMaxRetries: number;
}

export const DEFAULT_CHANNELS_CONFIG: ChannelsConfig = {
  sendProgress: true,
  sendToolHints: false,
  showReasoning: true,
  sendMaxRetries: 3,
};

export function parseChannelsConfig(value: unknown, path = 'channels'): ChannelsConfig {
  const cfg = asRecord(value, path) as unknown as ChannelsConfig;
  assertBoolean(cfg.sendProgress, `${path}.sendProgress`);
  assertBoolean(cfg.sendToolHints, `${path}.sendToolHints`);
  assertBoolean(cfg.showReasoning, `${path}.showReasoning`);
  assertNonNegativeInt(cfg.sendMaxRetries, `${path}.sendMaxRetries`);
  return cfg;
}
