import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { withRetry } from '@paperclaw/core';

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const DOWNLOAD_TRIES = 2;

export interface DownloadResult {
  arxiv_id: string;
  ok: boolean;
  path?: string;
  bytes?: number;
  error?: string;
}

export interface DownloadPdfOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  idleTimeoutMs?: number;
}

/**
 * Download a single arXiv PDF to `<outputDir>/<arxiv_id>.pdf`. Per AC4:
 *  - filename is exactly `<arxiv_id>.pdf`
 *  - failures return an error string, never throw out of this layer
 *
 * Existing files are cache hits only after a lightweight PDF sanity check.
 * New downloads are written to `<id>.pdf.partial`, validated, then atomically
 * renamed into place so interrupted downloads cannot poison the final cache.
 */
export async function downloadPdf(
  arxivId: string,
  outputDir: string,
  opts: DownloadPdfOptions = {},
): Promise<DownloadResult> {
  let partialPath: string | undefined;
  try {
    const safe = arxivId.trim();
    if (!/^[a-zA-Z0-9._/-]+$/.test(safe)) {
      return { arxiv_id: arxivId, ok: false, error: 'invalid arxiv_id format' };
    }
    // Replace `/` (legacy ids like cs/0506075) so it's a single-segment filename
    const filename = `${safe.replace(/\//g, '_')}.pdf`;
    const outPath = join(outputDir, filename);
    partialPath = `${outPath}.partial`;
    const targetPartialPath = partialPath;
    await fs.mkdir(dirname(outPath), { recursive: true });

    const cached = await inspectPdf(outPath);
    if (cached.ok) {
      return { arxiv_id: arxivId, ok: true, path: outPath, bytes: cached.bytes };
    }
    if (cached.exists) {
      await fs.rm(outPath, { force: true });
    }
    await fs.rm(targetPartialPath, { force: true });

    const url = `https://arxiv.org/pdf/${safe}.pdf`;
    const bytes = await withRetry(
      async () => {
        await fs.rm(targetPartialPath, { force: true });
        const controller = new AbortController();
        return await withTimeout(
          () => downloadAttempt({
            url,
            partialPath: targetPartialPath,
            fetchFn: opts.fetchFn ?? fetch,
            controller,
            idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS,
          }),
          opts.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
          () => controller.abort(),
          `download timed out after ${opts.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS}ms`,
        );
      },
      { tries: DOWNLOAD_TRIES, baseMs: 1000 },
    );

    await assertValidPdf(targetPartialPath, bytes);
    await fs.rename(targetPartialPath, outPath);
    return { arxiv_id: arxivId, ok: true, path: outPath, bytes };
  } catch (err) {
    if (partialPath) await fs.rm(partialPath, { force: true }).catch(() => undefined);
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

async function downloadAttempt(opts: {
  url: string;
  partialPath: string;
  fetchFn: typeof fetch;
  controller: AbortController;
  idleTimeoutMs: number;
}): Promise<number> {
  const res = await opts.fetchFn(opts.url, {
    headers: { 'User-Agent': 'paperClaw/0.1 (https://github.com/FufuufuF/paperClaw)' },
    redirect: 'follow',
    signal: opts.controller.signal,
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

  const expectedBytes = parseContentLength(res.headers.get('content-length'));
  const stream = Readable.fromWeb(res.body as never);
  const fh = await fs.open(opts.partialPath, 'w');
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimedOut = false;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (opts.idleTimeoutMs <= 0) return;
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      opts.controller.abort();
    }, opts.idleTimeoutMs);
  };

  try {
    let total = 0;
    resetIdleTimer();
    try {
      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        await fh.write(buf);
        total += buf.length;
        resetIdleTimer();
      }
    } catch (err) {
      if (idleTimedOut) {
        throw new Error(`download stalled for ${opts.idleTimeoutMs}ms`);
      }
      throw err;
    }
    if (expectedBytes !== undefined && total !== expectedBytes) {
      throw new Error(`incomplete download: expected ${expectedBytes} bytes, got ${total}`);
    }
    return total;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    await fh.close();
  }
}

async function inspectPdf(path: string): Promise<{ exists: boolean; ok: boolean; bytes?: number; reason?: string }> {
  try {
    const st = await fs.stat(path);
    try {
      await assertValidPdf(path, st.size);
      return { exists: true, ok: true, bytes: st.size };
    } catch (err) {
      return {
        exists: true,
        ok: false,
        bytes: st.size,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, ok: false };
    throw err;
  }
}

async function assertValidPdf(path: string, expectedBytes?: number): Promise<void> {
  const st = await fs.stat(path);
  if (expectedBytes !== undefined && st.size !== expectedBytes) {
    throw new Error(`incomplete download: expected ${expectedBytes} bytes, got ${st.size}`);
  }
  if (st.size === 0) throw new Error('empty PDF file');
  const head = await readRange(path, 0, Math.min(st.size, 16));
  if (!head.toString('latin1').includes('%PDF-')) {
    throw new Error('invalid PDF header');
  }
  const tailStart = Math.max(0, st.size - 4096);
  const tail = await readRange(path, tailStart, st.size - tailStart);
  if (!tail.toString('latin1').includes('%%EOF')) {
    throw new Error('invalid PDF EOF marker');
  }
}

async function readRange(path: string, offset: number, length: number): Promise<Buffer> {
  const fh = await fs.open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  message: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await fn();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
