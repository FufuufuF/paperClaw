import {
  extractToolNames,
  renderPlainMessage,
  renderPlainMarkdown,
  renderToolSummary,
  renderPlainWelcome,
} from '../../packages/cli/src/ui/plain/render.js';
import {
  createSwitchPickerItems,
  moveSwitchSelection,
} from '../../packages/cli/src/ui/ink/switch-picker.js';
import { InkCliStore } from '../../packages/cli/src/ui/ink/store.js';
import { shouldUseInk } from '../../packages/cli/src/ui/terminal.js';
import { assert } from '../fixtures/index.js';

function testModeSelection(): void {
  assert(
    shouldUseInk({
      mode: 'auto',
      stdinIsTty: true,
      stdoutIsTty: true,
      env: {},
    }),
    'auto mode uses Ink in an interactive terminal',
  );
  assert(
    !shouldUseInk({
      mode: 'plain',
      stdinIsTty: true,
      stdoutIsTty: true,
      env: {},
    }),
    'plain mode disables Ink',
  );
  assert(
    !shouldUseInk({
      mode: 'ink',
      stdinIsTty: true,
      stdoutIsTty: false,
      env: {},
    }),
    'non-TTY stdout falls back to plain even when Ink is requested',
  );
  assert(
    !shouldUseInk({
      mode: 'auto',
      stdinIsTty: true,
      stdoutIsTty: true,
      env: { CI: 'true' },
    }),
    'CI falls back to plain',
  );
}

function testPlainRendering(): void {
  const welcome = renderPlainWelcome({
    provider: 'deepseek',
    model: 'deepseek-chat',
    profile: {
      path: '/tmp/profile.md',
      readCount: 0,
      personalization: 'cold',
    },
    session: { id: 'cli:default' },
  });
  assert(welcome.includes('paperClaw CLI'), 'welcome renders product name');
  assert(welcome.includes('/status'), 'welcome shows status command');
  assert(welcome.includes('deepseek-chat'), 'welcome shows model');
  assert(welcome.includes('cli:default'), 'welcome shows session id');

  const final = renderPlainMessage({
    kind: 'final',
    text: 'PDF 已保存到 output/pdfs/demo.pdf',
  });
  assert(final.startsWith('clawbot:'), 'final message keeps clawbot prefix');
  assert(final.includes('output/pdfs/demo.pdf'), 'plain rendering preserves paths');

  const error = renderPlainMessage({ kind: 'error', text: '失败' });
  assert(error.startsWith('error:'), 'error message keeps error prefix');

  const markdown = renderPlainMarkdown([
    '## Heading',
    '',
    '- read `section`',
    '',
    '> quoted',
    '',
    '```ts',
    'const value = 1;',
    '```',
  ].join('\n'));
  assert(markdown.includes('Heading'), 'plain markdown renders headings');
  assert(markdown.includes('read'), 'plain markdown renders lists');
  assert(markdown.includes('quoted'), 'plain markdown renders blockquotes');
  assert(markdown.includes('const value = 1;'), 'plain markdown preserves code block content');
}

function testToolExtraction(): void {
  const fromMetadata = extractToolNames({
    kind: 'tool_hint',
    text: '正在调用工具: ignored',
    metadata: { tools: ['search_arxiv', 'download_pdf'] },
  });
  assert(fromMetadata.join(',') === 'search_arxiv,download_pdf', 'tool names prefer metadata');

  const fromText = extractToolNames({
    kind: 'tool_hint',
    text: '正在调用工具: search_arxiv, triage_papers',
  });
  assert(fromText.join(',') === 'search_arxiv,triage_papers', 'tool names can be parsed from text');

  const summary = renderToolSummary([
    'read_paper_section',
    'preview_section_relations',
    'kg_get_node',
    'kg_get_node',
    'kg_get_node',
  ]);
  assert(
    summary === 'Reading paper section -> Finding related papers -> Loading related paper metadata × 3',
    `tool summary aggregates duplicate tools (${summary})`,
  );

  const renderedTool = renderPlainMessage({
    kind: 'tool_hint',
    text: '正在调用工具: ignored',
    metadata: { tools: ['kg_get_node', 'kg_get_node'] },
  });
  assert(renderedTool.includes('Loading related paper metadata × 2'), 'plain tool rendering is compact');
}

function testSwitchPickerItems(): void {
  const items = createSwitchPickerItems([
    {
      id: 'cli:agent-memory:ABCDEFGHIJ',
      sessionName: 'Agent Memory',
      uid: 'ABCDEFGHIJ',
      channel: 'cli',
      turnCount: 12,
      lastActiveAt: '2026-06-10T15:00:00.000Z',
      preview: 'last useful message',
    },
    {
      id: 'cli:default',
      turnCount: 4,
      lastActiveAt: '2026-06-10T14:00:00.000Z',
      preview: 'default preview',
    },
  ], 'cli:default');

  assert(items[0]!.index === 1, 'picker keeps 1-based switch index');
  assert(items[0]!.label === 'Agent Memory ABCDEFGHIJ', 'picker shows session name and uid');
  assert(items[0]!.preview === 'last useful message', 'picker exposes preview');
  assert(items[1]!.active === true, 'picker marks active session');
  assert(items[1]!.label === '默认会话 default', 'picker gives default session readable label');
  assert(moveSwitchSelection(0, 1, items.length) === 1, 'selection moves down');
  assert(moveSwitchSelection(0, -1, items.length) === 1, 'selection wraps up');

  const store = new InkCliStore();
  store.openSwitchPicker(items);
  assert(store.getSnapshot().switchPicker?.selectedIndex === 0, 'switch picker defaults to first session');
  store.replaceMessages([
    { id: 'old', role: 'system', text: 'old', timestamp: 1 },
    { id: 'new', role: 'user', text: 'restored history', timestamp: 2 },
  ]);
  assert(store.getSnapshot().messages.length === 2, 'store can replace visible transcript');
  assert(store.getSnapshot().messages[1]!.text === 'restored history', 'replacement transcript is visible');
}

function main(): void {
  testModeSelection();
  testPlainRendering();
  testToolExtraction();
  testSwitchPickerItems();
  console.log('✓ cli ui tests passed.');
}

main();
