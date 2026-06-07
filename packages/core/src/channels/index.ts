export type { Channel } from './base.js';
export {
  FeishuChannel,
  normalizeFeishuEvent,
  toFeishuTextPayload,
  type FeishuChannelOpts,
  type FeishuNormalizeResult,
} from './feishu.js';
export {
  DEFAULT_CHANNELS_CONFIG,
  parseChannelsConfig,
  type ChannelsConfig,
} from './config.js';
