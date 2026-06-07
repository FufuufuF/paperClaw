import { stdin, stdout } from 'node:process';
import type { CliUiMode } from '../channel/types.js';

export function requestedCliUiMode(env: NodeJS.ProcessEnv = process.env): CliUiMode {
  const raw = env.PAPERCLAW_CLI_UI?.trim().toLowerCase();
  if (raw === 'ink' || raw === 'plain' || raw === 'auto') return raw;
  return 'auto';
}

export function shouldUseInk(input: {
  mode?: CliUiMode;
  stdinIsTty?: boolean;
  stdoutIsTty?: boolean;
  env?: NodeJS.ProcessEnv;
} = {}): boolean {
  const mode = input.mode ?? requestedCliUiMode(input.env);
  if (mode === 'plain') return false;

  const env = input.env ?? process.env;
  const stdinIsTty = input.stdinIsTty ?? Boolean(stdin.isTTY);
  const stdoutIsTty = input.stdoutIsTty ?? Boolean(stdout.isTTY);
  if (!stdinIsTty || !stdoutIsTty) return false;
  if (env.CI === 'true') return false;

  return mode === 'ink' || mode === 'auto';
}

export function terminalColumns(stream: Pick<NodeJS.WriteStream, 'columns'> = stdout): number {
  return typeof stream.columns === 'number' && stream.columns > 20 ? stream.columns : 80;
}
