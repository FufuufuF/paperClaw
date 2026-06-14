import {
  assertNumberInRange,
  assertOptionalString,
  assertPositiveInt,
  assertString,
  assertStringArray,
  asRecord,
} from '../config/validation.js';
import type { ProviderName } from '../providers/config.js';
import { assertProviderName } from '../providers/config.js';

export interface InlineFallbackModel {
  provider: ProviderName;
  model: string;
  maxTokens?: number;
  contextWindowTokens?: number;
  temperature?: number;
}

export type FallbackModel = string | InlineFallbackModel;

export interface ModelPresetConfig {
  label?: string;
  provider: ProviderName;
  model: string;
  maxTokens: number;
  contextWindowTokens: number;
  temperature: number;
}

export interface AgentDefaultsConfig {
  workspace: string;
  storeDir: string;
  /** @deprecated use storeDir. Kept as a compatibility alias for older configs. */
  outputDir: string;
  provider: ProviderName;
  model: string;
  modelPreset?: string;
  maxTokens: number;
  contextWindowTokens: number;
  contextBlockLimit?: number;
  maxToolIterations: number;
  maxConcurrentSubagents: number;
  temperature: number;
  timezone: string;
  botName: string;
  unifiedSession: boolean;
  disabledSkills: string[];
  fallbackModels: FallbackModel[];
}

export interface AgentsConfig {
  defaults: AgentDefaultsConfig;
  presets: Record<string, ModelPresetConfig>;
}

export const DEFAULT_AGENTS_CONFIG: AgentsConfig = {
  defaults: {
    workspace: '.',
    storeDir: 'nanobot-store',
    outputDir: 'nanobot-store',
    provider: 'deepseek',
    model: 'deepseek-chat',
    maxTokens: 8192,
    contextWindowTokens: 24000,
    maxToolIterations: 30,
    maxConcurrentSubagents: 1,
    temperature: 0.3,
    timezone: 'Asia/Shanghai',
    botName: 'clawbot',
    unifiedSession: false,
    disabledSkills: [],
    fallbackModels: [],
  },
  presets: {},
};

export function parseAgentsConfig(value: unknown, path = 'agents'): AgentsConfig {
  const cfg = asRecord(value, path) as unknown as AgentsConfig;
  validateAgentDefaults(cfg.defaults, `${path}.defaults`);
  validateModelPresets(cfg.presets, `${path}.presets`);
  return cfg;
}

function validateAgentDefaults(defaults: AgentDefaultsConfig, path: string): void {
  asRecord(defaults, path);
  assertString(defaults.workspace, `${path}.workspace`);
  assertString(defaults.storeDir, `${path}.storeDir`);
  assertString(defaults.outputDir, `${path}.outputDir`);
  assertProviderName(defaults.provider, `${path}.provider`);
  assertString(defaults.model, `${path}.model`);
  assertOptionalString(defaults.modelPreset, `${path}.modelPreset`);
  assertPositiveInt(defaults.maxTokens, `${path}.maxTokens`);
  assertPositiveInt(defaults.contextWindowTokens, `${path}.contextWindowTokens`);
  if (defaults.contextBlockLimit !== undefined) {
    assertPositiveInt(defaults.contextBlockLimit, `${path}.contextBlockLimit`);
  }
  assertPositiveInt(defaults.maxToolIterations, `${path}.maxToolIterations`);
  assertPositiveInt(defaults.maxConcurrentSubagents, `${path}.maxConcurrentSubagents`);
  assertNumberInRange(defaults.temperature, 0, 2, `${path}.temperature`);
  assertString(defaults.timezone, `${path}.timezone`);
  assertString(defaults.botName, `${path}.botName`);
  if (typeof defaults.unifiedSession !== 'boolean') {
    throw new Error(`${path}.unifiedSession must be a boolean`);
  }
  assertStringArray(defaults.disabledSkills, `${path}.disabledSkills`);
  validateFallbackModels(defaults.fallbackModels, `${path}.fallbackModels`);
}

function validateModelPresets(presets: Record<string, ModelPresetConfig>, path: string): void {
  asRecord(presets, path);
  for (const [name, preset] of Object.entries(presets)) {
    asRecord(preset, `${path}.${name}`);
    assertOptionalString(preset.label, `${path}.${name}.label`);
    assertProviderName(preset.provider, `${path}.${name}.provider`);
    assertString(preset.model, `${path}.${name}.model`);
    assertPositiveInt(preset.maxTokens, `${path}.${name}.maxTokens`);
    assertPositiveInt(preset.contextWindowTokens, `${path}.${name}.contextWindowTokens`);
    assertNumberInRange(preset.temperature, 0, 2, `${path}.${name}.temperature`);
  }
}

function validateFallbackModels(value: FallbackModel[], path: string): void {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  for (const [idx, item] of value.entries()) {
    const itemPath = `${path}[${idx}]`;
    if (typeof item === 'string') continue;
    asRecord(item, itemPath);
    assertProviderName(item.provider, `${itemPath}.provider`);
    assertString(item.model, `${itemPath}.model`);
    if (item.maxTokens !== undefined) assertPositiveInt(item.maxTokens, `${itemPath}.maxTokens`);
    if (item.contextWindowTokens !== undefined) {
      assertPositiveInt(item.contextWindowTokens, `${itemPath}.contextWindowTokens`);
    }
    if (item.temperature !== undefined) assertNumberInRange(item.temperature, 0, 2, `${itemPath}.temperature`);
  }
}
