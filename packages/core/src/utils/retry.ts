/**
 * Retry with exponential backoff. Only retries when the thrown error has
 * `.transient === true` (set by the caller, e.g. on 5xx / 429).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { tries?: number; baseMs?: number } = {},
): Promise<T> {
  const tries = opts.tries ?? 3;
  const baseMs = opts.baseMs ?? 500;
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const transient = (err as { transient?: boolean })?.transient === true;
      if (!transient || i === tries - 1) throw err;
      const wait = baseMs * Math.pow(2, i) + Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
