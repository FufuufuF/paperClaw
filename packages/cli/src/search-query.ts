#!/usr/bin/env node
/**
 * `pnpm search:query "<query>"` — F3 / AC1 driver.
 *
 * Loads .env, runs queryFlow, prints a human-readable shortlist + the run
 * directory so the user can subsequently call `search:download <run_id> ...`.
 */
import { loadEnv, createLLMClient } from '@paperclaw/core';
import { queryFlow } from '@paperclaw/search';

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: pnpm search:query "<query>"');
    process.exit(2);
  }
  const query = args.join(' ');

  const llm = createLLMClient();
  console.log(`[paperClaw] query="${query}" llm=${llm.id}`);

  const t0 = Date.now();
  const result = await queryFlow({ query, llm });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('');
  console.log(`run_id:   ${result.run_id}`);
  console.log(`out_dir:  ${result.out_dir}`);
  console.log(`rounds:   ${result.rounds}`);
  console.log(`terms:    ${result.used_terms.join(' | ')}`);
  console.log(`elapsed:  ${elapsed}s`);
  if (result.filtered_already_read.length > 0) {
    console.log(`filtered: ${result.filtered_already_read.length} already-read papers`);
  }
  console.log(`shortlist (${result.shortlist.length}):`);
  console.log('');
  for (const [i, row] of result.shortlist.entries()) {
    const tag =
      row.verdict === 'recommend' ? '⭐' : row.verdict === 'maybe' ? '·' : '×';
    const authors = row.authors.slice(0, 2).join(', ') + (row.authors.length > 2 ? ' 等' : '');
    console.log(`${String(i + 1).padStart(2)}. ${tag} ${row.arxiv_id}  ${row.title}`);
    console.log(`    ${authors} · ${row.year} · matched="${row.matched_term}"`);
    console.log(`    reason: ${row.reason}`);
    if (row.summary) console.log(`    summary: ${row.summary}`);
    console.log('');
  }
  console.log(`To download: pnpm search:download ${result.run_id} <arxiv_id> [<arxiv_id> ...]`);
  console.log(`Trace: ${result.trace_path}`);
}

main().catch((err) => {
  console.error('[paperClaw] query flow failed:', err);
  process.exit(1);
});
