import type { CommandRuntimeStatus, OutboundMessage } from '@paperclaw/core';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

const plainMarked = new Marked(markedTerminal({
  reflowText: false,
  showSectionPrefix: true,
  tab: 2,
}));

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
    : renderPlainMarkdown(msg.text);
  const lines = text.split('\n');
  const pad = ' '.repeat(prefix.length);
  const padded = lines.map((line, idx) => (idx === 0 ? `${prefix}: ${line}` : `${pad}  ${line}`));
  return padded.join('\n') + '\n';
}

export function renderPlainMarkdown(text: string): string {
  const rendered = plainMarked.parse(text, { async: false });
  return rendered.replace(/\n+$/g, '');
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

export function summarizeToolNames(tools: string[]): string[] {
  const counts = new Map<string, number>();
  const ordered: string[] = [];
  for (const tool of tools) {
    if (!counts.has(tool)) {
      ordered.push(tool);
      counts.set(tool, 0);
    }
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  return ordered.map((tool) => {
    const label = toolDisplayName(tool);
    const count = counts.get(tool) ?? 1;
    return count > 1 ? `${label} × ${count}` : label;
  });
}

export function renderToolSummary(tools: string[]): string {
  const summary = summarizeToolNames(tools);
  return summary.length > 0 ? summary.join(' -> ') : '';
}

function renderToolHint(msg: OutboundMessage): string {
  const tools = extractToolNames(msg);
  return renderToolSummary(tools) || msg.text;
}

function toolDisplayName(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

const TOOL_LABELS: Record<string, string> = {
  read_paper: 'Preparing guided reading',
  read_paper_section: 'Reading paper section',
  preview_section_relations: 'Finding related papers',
  kg_get_node: 'Loading related paper metadata',
  kg_neighbors: 'Reading paper graph neighbors',
  kg_get_link: 'Reading paper graph relation',
  kg_search_nodes: 'Searching paper graph',
  kg_search_links: 'Searching paper graph links',
  paper_search: 'Searching papers',
  search_arxiv: 'Searching arXiv',
  triage_papers: 'Ranking papers',
  download_paper: 'Downloading PDFs',
  download_pdf: 'Downloading PDFs',
  read_note: 'Reading saved notes',
  record_paper_section_note: 'Saving section note',
  consolidate_paper: 'Updating paper graph',
};
