#!/usr/bin/env node
/**
 * `pnpm search:cron` — F4 / AC5 driver.
 *
 * No query input. Reads `output/profile.md`, infers directions, generates a
 * shortlist. If profile is too thin, prints a friendly "笔记不足" message
 * and exits 0 (per AC5: report rather than crash).
 */
import { loadEnv, createLLMClient } from '@paperclaw/core';
import { cronFlow } from '@paperclaw/search';

async function main() {
  loadEnv();
  const llm = createLLMClient();
  console.log(`[paperClaw] cron flow · llm=${llm.id}`);

  const t0 = Date.now();
  const result = await cronFlow({ llm });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (result.not_enough_profile) {
    console.log('');
    console.log(`⚠ 笔记不足, 无法推荐: ${result.not_enough_profile.reason}`);
    console.log(`  (run_id=${result.run_id}, meta=${result.meta_path})`);
    process.exit(0);
  }

  console.log('');
  console.log(`run_id:    ${result.run_id}`);
  console.log(`summary:   ${result.summary}`);
  console.log(`directions:`);
  for (const d of result.directions) {
    console.log(`  - ${d.theme}  · term="${d.term}"  · 依据=[[${d.evidence_slug}]]`);
  }
  console.log(`elapsed:   ${elapsed}s`);
  console.log(`shortlist (${result.shortlist.length}):`);
  console.log('');
  for (const [i, row] of result.shortlist.entries()) {
    const tag = row.verdict === 'recommend' ? '⭐' : '·';
    console.log(`${String(i + 1).padStart(2)}. ${tag} ${row.arxiv_id}  ${row.title}`);
    console.log(`    reason: ${row.reason}`);
    if (row.summary) console.log(`    summary: ${row.summary}`);
    console.log('');
  }
  console.log(`To download: pnpm search:download ${result.run_id} <arxiv_id> [<arxiv_id> ...]`);
}

main().catch((err) => {
  console.error('[paperClaw] cron flow failed:', err);
  process.exit(1);
});
