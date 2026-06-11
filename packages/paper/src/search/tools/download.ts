import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { withRetry } from '@paperclaw/core';

export interface DownloadResult {
  arxiv_id: string;
  ok: boolean;
  path?: string;
  bytes?: number;
  error?: string;
}

/**
 * Download a single arXiv PDF to `<outputDir>/<arxiv_id>.pdf`. Per AC4:
 *  - filename is exactly `<arxiv_id>.pdf`
 *  - failures return an error string, never throw out of this layer
 *
 * If the file already exists with non-zero size we treat it as a cache hit
 * (idempotent — the user can re-run `search:download` safely).
 */
export async function downloadPdf(arxivId: string, outputDir: string): Promise<DownloadResult> {
  try {
    const safe = arxivId.trim();
    if (!/^[a-zA-Z0-9._/-]+$/.test(safe)) {
      return { arxiv_id: arxivId, ok: false, error: 'invalid arxiv_id format' };
    }
    // Replace `/` (legacy ids like cs/0506075) so it's a single-segment filename
    const filename = `${safe.replace(/\//g, '_')}.pdf`;
    const outPath = join(outputDir, filename);
    await fs.mkdir(dirname(outPath), { recursive: true });

    // Cache hit: skip re-download
    try {
      const st = await fs.stat(outPath);
      if (st.size > 1024) {
        return { arxiv_id: arxivId, ok: true, path: outPath, bytes: st.size };
      }
    } catch {
      // not present, proceed
    }

    const url = `https://arxiv.org/pdf/${safe}.pdf`;
    const bytes = await withRetry(
      async () => {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'paperClaw/0.1 (https://github.com/FufuufuF/paperClaw)' },
          redirect: 'follow',
        });
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status}`);
          (err as Error & { transient?: boolean }).transient = res.status >= 500 || res.status === 429;
          throw err;
        }
        const ct = res.headers.get('content-type') ?? '';
        if (!ct.includes('pdf') && !ct.includes('octet-stream')) {
          throw new Error(`unexpected content-type: ${ct}`);
        }
        if (!res.body) throw new Error('empty response body');
        // Node 20+ has Web ReadableStream → fs.createWriteStream via Readable.fromWeb
        const stream = Readable.fromWeb(res.body as never);
        const fh = await fs.open(outPath, 'w');
        try {
          let total = 0;
          for await (const chunk of stream) {
            const buf = chunk as Buffer;
            await fh.write(buf);
            total += buf.length;
          }
          return total;
        } finally {
          await fh.close();
        }
      },
      { tries: 3, baseMs: 1000 },
    );

    return { arxiv_id: arxivId, ok: true, path: outPath, bytes };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { arxiv_id: arxivId, ok: false, error: msg };
  }
}

/**
 * Bulk wrapper. Downloads sequentially (not parallel) to be polite to arXiv;
 * users typically pick 3-10 papers, so sequential is fine.
 */
export async function downloadPdfs(
  arxivIds: string[],
  outputDir: string,
): Promise<DownloadResult[]> {
  const results: DownloadResult[] = [];
  for (const id of arxivIds) {
    results.push(await downloadPdf(id, outputDir));
  }
  return results;
}
