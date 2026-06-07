import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { CliMessage, CliMessageRole } from '../../../channel/types.js';

export function MessageBlock({ message }: { message: CliMessage }) {
  const label = labelFor(message.role);
  const color = colorFor(message.role);
  const lines = message.text.split('\n');

  return (
    <Box flexDirection="column" marginBottom={message.role === 'progress' ? 0 : 1}>
      <Box>
        <Text color={color} bold>{label}</Text>
        {message.role === 'tool' || message.role === 'progress' ? null : (
          <Text dimColor> {formatTime(message.timestamp)}</Text>
        )}
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        {lines.map((line, idx) => (
          <Text key={idx} wrap="wrap">
            <HighlightedText text={line} fallbackColor={message.role === 'error' ? 'red' : undefined} />
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function HighlightedText(props: { text: string; fallbackColor?: string }) {
  const parts = splitHighlights(props.text);
  return (
    <>
      {parts.map((part, idx) => {
        if (part.kind === 'path') {
          return <Text key={idx} color="yellow">{part.text}</Text>;
        }
        if (part.kind === 'command') {
          return <Text key={idx} color="cyan">{part.text}</Text>;
        }
        if (props.fallbackColor) {
          return <Text key={idx} color={props.fallbackColor}>{part.text}</Text>;
        }
        return part.text as ReactNode;
      })}
    </>
  );
}

type HighlightPart = {
  text: string;
  kind: 'plain' | 'path' | 'command';
};

const highlightPattern = /(\/(?:help|status|papers|cost|cron|stop|quit|exit|profile|session|new|clear|model)\b|(?:\/Users\/|output\/|\.\/|\.\.\/)[^\s，。；,;]+)/g;

function splitHighlights(text: string): HighlightPart[] {
  const parts: HighlightPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(highlightPattern)) {
    const value = match[0];
    const index = match.index ?? cursor;
    if (index > cursor) {
      parts.push({ text: text.slice(cursor, index), kind: 'plain' });
    }
    parts.push({
      text: value,
      kind: value.startsWith('/') && !value.startsWith('/Users/') ? 'command' : 'path',
    });
    cursor = index + value.length;
  }
  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), kind: 'plain' });
  }
  return parts.length > 0 ? parts : [{ text, kind: 'plain' }];
}

function labelFor(role: CliMessageRole): string {
  return role === 'user' ? 'you'
    : role === 'assistant' ? 'clawbot'
      : role === 'tool' ? 'tool'
        : role === 'progress' ? 'progress'
          : role === 'error' ? 'error'
            : 'system';
}

function colorFor(role: CliMessageRole): string {
  return role === 'user' ? 'green'
    : role === 'assistant' ? 'cyan'
      : role === 'tool' ? 'magenta'
        : role === 'progress' ? 'gray'
          : role === 'error' ? 'red'
            : 'gray';
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
}
