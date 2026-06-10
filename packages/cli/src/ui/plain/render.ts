import type { CommandRuntimeStatus, OutboundMessage } from '@paperclaw/core';

export function renderPlainWelcome(status?: CommandRuntimeStatus): string {
  const lines = ['paperClaw CLI'];
  if (status) {
    lines.push(
      `模型: ${status.model ?? 'unknown'}        profile: ${status.profile?.personalization ?? 'unknown'}        session: ${status.session?.id ?? 'unknown'}`,
    );
  }
  lines.push('', '/help 查看命令          /status 查看状态          /quit 退出', '');
  return lines.join('\n');
}

export function renderPlainMessage(msg: OutboundMessage): string {
  const kind = msg.kind ?? 'final';
  if (kind === 'reasoning' && process.env.PAPERCLAW_CLI_SHOW_REASONING !== '1') {
    return '';
  }

  const prefix =
    kind === 'progress' ? '...' :
    kind === 'tool_hint' ? 'tool' :
    kind === 'error' ? 'error' :
    'clawbot';

  const text = kind === 'tool_hint'
    ? renderToolHint(msg)
    : msg.text;
  const lines = text.split('\n');
  const pad = ' '.repeat(prefix.length);
  const padded = lines.map((line, idx) => (idx === 0 ? `${prefix}: ${line}` : `${pad}  ${line}`));
  return padded.join('\n') + '\n';
}

export function extractToolNames(msg: OutboundMessage): string[] {
  const tools = msg.metadata?.tools;
  if (Array.isArray(tools)) {
    return tools.filter((tool): tool is string => typeof tool === 'string' && tool.length > 0);
  }

  const raw = msg.text.replace(/^正在调用工具:\s*/, '').trim();
  if (!raw) return [];
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function renderToolHint(msg: OutboundMessage): string {
  const tools = extractToolNames(msg);
  return tools.length > 0 ? tools.join(', ') : msg.text;
}
