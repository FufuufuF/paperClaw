#!/usr/bin/env node
/**
 * `pnpm search:download <run_id> <arxiv_id> [<arxiv_id> ...]` — F5 / AC4.
 *
 * Per design.md §6 + AC4, PDFs land in `output/pdfs/<arxiv_id>.pdf` (cross-run,
 * not under `<run_id>/`). The run_id arg is required for trace appending so
 * the download is attributable, but it's not the storage location.
 *
 * If `--all` is passed instead of arxiv_ids, we read the run's shortlist.json
 * and download every `verdict !== 'skip'` row.
 */
import { join, resolve } from 'node:path';
import { promises as fs } from 'node:fs';
import { loadEnv, getRepoRoot, TraceBus } from '@paperclaw/core';
import { downloadPdfs } from '@paperclaw/search';

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('usage: pnpm search:download <run_id> <arxiv_id> [<arxiv_id> ...]');
    console.error('       pnpm search:download <run_id> --all');
    process.exit(2);
  }
  const runId = args[0]!;
  const rest = args.slice(1);

  const root = getRepoRoot();
  const runDir = resolve(root, 'output', runId);
  const pdfDir = resolve(root, 'output', 'pdfs');

  let arxivIds: string[];
  if (rest[0] === '--all') {
    const shortlistPath = join(runDir, 'shortlist.json');
    const raw = await fs.readFile(shortlistPath, 'utf8');
    const data = JSON.parse(raw) as { shortlist: Array<{ arxiv_id: string; verdict: string }> };
    arxivIds = data.shortlist.filter((r) => r.verdict !== 'skip').map((r) => r.arxiv_id);
    if (arxivIds.length === 0) {
      console.log('shortlist 中没有 verdict ≠ skip 的论文');
      process.exit(0);
    }
  } else {
    arxivIds = rest;
  }

  // Append a download trace event to the run's trace.jsonl so the trail is complete.
  const tracePath = join(runDir, 'trace.jsonl');
  const trace = new TraceBus(tracePath, 'master');
  await trace.emit('download', 'tool_call', {
    tool: 'download_pdfs',
    args: { arxiv_ids: arxivIds },
  });

  console.log(`[paperClaw] downloading ${arxivIds.length} PDF(s) → ${pdfDir}`);
  const results = await downloadPdfs(arxivIds, pdfDir);

  let okCount = 0;
  for (const r of results) {
    if (r.ok) {
      okCount += 1;
      const kb = r.bytes ? `${(r.bytes / 1024).toFixed(0)} KB` : '?';
      console.log(`  ✓ ${r.arxiv_id}  →  ${r.path}  (${kb})`);
    } else {
      console.log(`  ✗ ${r.arxiv_id}  failed: ${r.error}`);
    }
  }
  await trace.emit('download', 'observation', {
    tool: 'download_pdfs',
    ok: okCount,
    failed: results.length - okCount,
    results,
  });
  await trace.close();

  console.log('');
  console.log(`done: ${okCount}/${results.length} succeeded.`);
  process.exit(okCount === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('[paperClaw] download failed:', err);
  process.exit(1);
});
