/**
 * Generate a run id matching design.md §13: ISO timestamp + short hash.
 * Hash is just 4 random hex chars — collision-resistant enough for one user.
 */
export function getRunId(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '').replace(/(\d{4})(\d{2})(\d{2})T(\d{6}).*/, '$1-$2-$3T$4');
  const hash = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `${iso}-${hash}`;
}
