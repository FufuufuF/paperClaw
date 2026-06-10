import type { SessionListing } from '@paperclaw/core';
import type { CliSwitchPickerItem } from '../../channel/types.js';

export function createSwitchPickerItems(
  sessions: SessionListing[],
  activeSessionId: string,
): CliSwitchPickerItem[] {
  return sessions.map((session, idx) => ({
    index: idx + 1,
    id: session.id,
    label: sessionDisplayName(session),
    preview: session.preview?.trim() || '(暂无消息)',
    lastActiveAt: session.lastActiveAt || 'unknown',
    turnCount: session.turnCount,
    active: session.id === activeSessionId,
  }));
}

export function moveSwitchSelection(current: number, delta: number, total: number): number {
  if (total <= 0) return 0;
  return (current + delta + total) % total;
}

function sessionDisplayName(session: SessionListing): string {
  const parsed = parseSessionId(session.id);
  const name = session.sessionName?.trim()
    || parsed.sessionName
    || (session.id === 'cli:default' ? '默认会话' : '未命名');
  const uid = session.uid ?? parsed.uid;
  return uid ? `${name} ${uid}` : name;
}

function parseSessionId(id: string): { sessionName?: string; uid?: string } {
  const parts = id.split(':').filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { uid: parts[0] };
  if (parts.length === 2) return { uid: parts[1] };
  return {
    sessionName: parts.slice(1, -1).join(':'),
    uid: parts.at(-1),
  };
}
