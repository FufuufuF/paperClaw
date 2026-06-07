import {
  extractToolNames,
  renderPlainMessage,
  renderPlainWelcome,
} from '../../packages/cli/src/ui/plain/render.js';
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
  });
  assert(welcome.includes('paperClaw CLI'), 'welcome renders product name');
  assert(welcome.includes('/status'), 'welcome shows status command');
  assert(welcome.includes('deepseek-chat'), 'welcome shows model');

  const final = renderPlainMessage({
    kind: 'final',
    text: 'PDF 已保存到 output/pdfs/demo.pdf',
  });
  assert(final.startsWith('clawbot:'), 'final message keeps clawbot prefix');
  assert(final.includes('output/pdfs/demo.pdf'), 'plain rendering preserves paths');

  const error = renderPlainMessage({ kind: 'error', text: '失败' });
  assert(error.startsWith('error:'), 'error message keeps error prefix');
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
}

function main(): void {
  testModeSelection();
  testPlainRendering();
  testToolExtraction();
  console.log('✓ cli ui tests passed.');
}

main();
