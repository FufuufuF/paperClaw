/**
 * Bounded-concurrency map. Keeps `limit` workers busy; preserves input order
 * in the output array. Used by triage to bound parallelism on the LLM.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let w = 0; w < n; w++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= items.length) return;
          results[idx] = await fn(items[idx]!, idx);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}
