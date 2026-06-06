import { DEFAULT_AGENTS_CONFIG, parseAgentsConfig, type AgentsConfig } from '../agent/config.js';
import { DEFAULT_TOOLS_CONFIG, parseToolsConfig, type ToolsConfig } from '../agent/tools/config.js';
import { DEFAULT_CHANNELS_CONFIG, parseChannelsConfig, type ChannelsConfig } from '../channels/config.js';
import { DEFAULT_PROVIDERS_CONFIG, parseProvidersConfig, type ProvidersConfig } from '../providers/config.js';
import { DEFAULT_SESSION_CONFIG, parseSessionConfig, type SessionConfig } from '../session/config.js';
import { mergeConfig } from './merge.js';
import { assertLiteral, asRecord } from './validation.js';

export interface PaperClawConfig {
  version: 1;
  agents: AgentsConfig;
  providers: ProvidersConfig;
  tools: ToolsConfig;
  channels: ChannelsConfig;
  session: SessionConfig;
}

export const DEFAULT_CONFIG: PaperClawConfig = {
  version: 1,
  agents: DEFAULT_AGENTS_CONFIG,
  providers: DEFAULT_PROVIDERS_CONFIG,
  tools: DEFAULT_TOOLS_CONFIG,
  channels: DEFAULT_CHANNELS_CONFIG,
  session: DEFAULT_SESSION_CONFIG,
};

export function parsePaperClawConfig(raw: unknown = {}): PaperClawConfig {
  const merged = mergeConfig(DEFAULT_CONFIG, asRecord(raw, 'config'));
  assertLiteral(merged.version, 1, 'version');
  return {
    version: 1,
    agents: parseAgentsConfig(merged.agents),
    providers: parseProvidersConfig(merged.providers),
    tools: parseToolsConfig(merged.tools),
    channels: parseChannelsConfig(merged.channels),
    session: parseSessionConfig(merged.session),
  };
}
