import { Box, Text } from 'ink';
import { useMemo, type ReactNode } from 'react';
import { Marked, type Token, type Tokens } from 'marked';
import type { CliMessage, CliMessageRole } from '../../../channel/types.js';

const inkMarked = new Marked();

export function MessageBlock({ message }: { message: CliMessage }) {
  const label = labelFor(message.role);
  const color = colorFor(message.role);

  return (
    <Box flexDirection="column" marginBottom={message.role === 'progress' ? 0 : 1}>
      <Box>
        <Text color={color} bold>{label}</Text>
        {message.role === 'tool' || message.role === 'progress' ? null : (
          <Text dimColor> {formatTime(message.timestamp)}</Text>
        )}
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        <MarkdownContent text={message.text} fallbackColor={message.role === 'error' ? 'red' : undefined} />
      </Box>
    </Box>
  );
}

function MarkdownContent(props: { text: string; fallbackColor?: string }) {
  const tokens = useMemo(() => inkMarked.lexer(props.text), [props.text]);
  return (
    <>
      {tokens.map((token, idx) => renderBlockToken(token, `block-${idx}`, props.fallbackColor))}
    </>
  );
}

function renderBlockToken(token: Token, key: string, fallbackColor?: string): ReactNode {
  switch (token.type) {
    case 'space':
      return <Text key={key}> </Text>;
    case 'heading':
      const heading = token as Tokens.Heading;
      return (
        <Box key={key} marginTop={heading.depth <= 2 ? 1 : 0}>
          <Text color={heading.depth <= 2 ? 'cyan' : undefined} bold underline={heading.depth <= 2}>
            <InlineTokens tokens={heading.tokens} fallbackColor={fallbackColor} />
          </Text>
        </Box>
      );
    case 'paragraph':
      const paragraph = token as Tokens.Paragraph;
      return (
        <Text key={key} wrap="wrap">
          <InlineTokens tokens={paragraph.tokens} fallbackColor={fallbackColor} />
        </Text>
      );
    case 'blockquote':
      const blockquote = token as Tokens.Blockquote;
      return (
        <Box key={key}>
          <Text color="gray">{'> '}</Text>
          <Text wrap="wrap" color="gray">
            {plainTextFromTokens(blockquote.tokens)}
          </Text>
        </Box>
      );
    case 'list': {
      const list = token as Tokens.List;
      return (
        <Box key={key} flexDirection="column">
          {list.items.map((item: Tokens.ListItem, idx: number) => renderListItem(item, list.ordered, list.start, idx, `${key}-item-${idx}`, fallbackColor))}
        </Box>
      );
    }
    case 'code':
      const code = token as Tokens.Code;
      return (
        <Box key={key} flexDirection="column" marginY={1}>
          <Text dimColor>{`\`\`\`${code.lang ?? ''}`}</Text>
          {code.text.split('\n').map((line: string, idx: number) => (
            <Text key={`${key}-line-${idx}`} color="yellow" wrap="wrap">{line || ' '}</Text>
          ))}
          <Text dimColor>```</Text>
        </Box>
      );
    case 'hr':
      return <Text key={key} dimColor>----------------------------------------</Text>;
    case 'table':
      const table = token as Tokens.Table;
      return (
        <Box key={key} flexDirection="column" marginY={1}>
          {table.raw.trimEnd().split('\n').map((line: string, idx: number) => (
            <Text key={`${key}-table-${idx}`} color="gray" wrap="wrap">{line}</Text>
          ))}
        </Box>
      );
    case 'html':
      const html = token as Tokens.HTML;
      return <Text key={key} dimColor wrap="wrap">{html.text}</Text>;
    default:
      return <Text key={key} wrap="wrap">{plainTextFromToken(token)}</Text>;
  }
}

function renderListItem(
  item: Tokens.ListItem,
  ordered: boolean,
  start: number | '',
  idx: number,
  key: string,
  fallbackColor?: string,
): ReactNode {
  const marker = ordered ? `${(typeof start === 'number' ? start : 1) + idx}.` : '-';
  const inline = inlineTokensFromListItem(item);
  return (
    <Text key={key} wrap="wrap">
      <Text dimColor>{`${marker} `}</Text>
      <InlineTokens tokens={inline} fallbackColor={fallbackColor} />
    </Text>
  );
}

function inlineTokensFromListItem(item: Tokens.ListItem): Token[] {
  const first = item.tokens[0];
  if (first?.type === 'paragraph') return (first as Tokens.Paragraph).tokens;
  if (first?.type === 'text' && (first as Tokens.Text).tokens) return (first as Tokens.Text).tokens ?? [];
  return item.tokens;
}

function InlineTokens(props: { tokens: Token[]; fallbackColor?: string }) {
  return (
    <>
      {props.tokens.map((token, idx) => renderInlineToken(token, `inline-${idx}`, props.fallbackColor))}
    </>
  );
}

function renderInlineToken(token: Token, key: string, fallbackColor?: string): ReactNode {
  switch (token.type) {
    case 'text':
      const text = token as Tokens.Text;
      if (text.tokens) return <InlineTokens key={key} tokens={text.tokens} fallbackColor={fallbackColor} />;
      return <HighlightedText key={key} text={text.text} fallbackColor={fallbackColor} />;
    case 'escape':
      return <HighlightedText key={key} text={(token as Tokens.Escape).text} fallbackColor={fallbackColor} />;
    case 'codespan':
      return <Text key={key} color="yellow">{`\`${(token as Tokens.Codespan).text}\``}</Text>;
    case 'strong':
      const strong = token as Tokens.Strong;
      return (
        <Text key={key} bold>
          <InlineTokens tokens={strong.tokens} fallbackColor={fallbackColor} />
        </Text>
      );
    case 'em':
      const em = token as Tokens.Em;
      return (
        <Text key={key} dimColor>
          <InlineTokens tokens={em.tokens} fallbackColor={fallbackColor} />
        </Text>
      );
    case 'del':
      const del = token as Tokens.Del;
      return (
        <Text key={key} dimColor>
          <InlineTokens tokens={del.tokens} fallbackColor={fallbackColor} />
        </Text>
      );
    case 'link': {
      const link = token as Tokens.Link;
      const href = link.href.trim();
      return (
        <Text key={key} color="blue" underline>
          <InlineTokens tokens={link.tokens} fallbackColor={fallbackColor} />
          {href && href !== link.text ? <Text dimColor>{` (${href})`}</Text> : null}
        </Text>
      );
    }
    case 'image':
      const image = token as Tokens.Image;
      return <Text key={key} color="blue">{`![${image.text}](${image.href})`}</Text>;
    case 'br':
      return '\n';
    case 'html':
      return <Text key={key} dimColor>{(token as Tokens.HTML).text}</Text>;
    default:
      return <HighlightedText key={key} text={plainTextFromToken(token)} fallbackColor={fallbackColor} />;
  }
}

function plainTextFromTokens(tokens: Token[]): string {
  return tokens.map(plainTextFromToken).join('');
}

function plainTextFromToken(token: Token): string {
  if ('text' in token && typeof token.text === 'string') return token.text;
  if ('raw' in token && typeof token.raw === 'string') return token.raw;
  return '';
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

const highlightPattern = /(\/(?:help|status|papers|cost|cron|stop|quit|exit|profile|session|switch|history|new|clear|model)\b|(?:\/Users\/|output\/|\.\/|\.\.\/)[^\s，。；,;]+)/g;

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
