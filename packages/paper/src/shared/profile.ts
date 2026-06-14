import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PROFILE_SKILLS_DIR = fileURLToPath(new URL('./skills', import.meta.url));

/**
 * Snapshot of `<store>/profile.md` for the paperClaw business workflow.
 */
export interface ProfileSnapshot {
  /** absolute path that was attempted */
  path: string;
  /** raw markdown if it existed, null otherwise */
  raw: string | null;
  /** parsed [[slug]] entries from the 已读索引 section (lowercased) */
  readSlugs: string[];
  /** whether the profile is usable for personalization (per §1.2 thresholds) */
  hasSignal: boolean;
}

export async function readProfile(path: string): Promise<ProfileSnapshot> {
  let raw: string | null = null;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Cold start — graceful per F7 / AC1
      return { path, raw: null, readSlugs: [], hasSignal: false };
    }
    throw err;
  }

  const readSlugs = extractReadSlugs(raw);
  // Per design.md §1.2: 0-2 笔记不做 personalization, 3-7 弱, 8+ 完整
  const hasSignal = readSlugs.length >= 3;
  return { path, raw, readSlugs, hasSignal };
}

/**
 * Pull `[[slug]]` entries out of the 已读索引 section. We deliberately scan
 * only that section, not the entire file, so a `[[slug]]` mentioned in
 * "## 待问用户" doesn't get treated as already-read.
 */
function extractReadSlugs(md: string): string[] {
  const lines = md.split('\n');
  let inSection = false;
  const slugs: string[] = [];
  // Slug grammar: paper-reader uses [a-z0-9-]+; we additionally accept `.`
  // and `/` so an entry written as [[2401.12345]] or [[cs/0506075]] (legacy
  // arXiv ids) is recognised as already-read.
  const linkRe = /\[\[([a-z0-9][a-z0-9./-]*)\]\]/gi;
  for (const line of lines) {
    if (/^##\s+已读索引/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) break; // next section
    if (!inSection) continue;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(line)) !== null) {
      slugs.push(m[1]!.toLowerCase());
    }
  }
  // dedupe but keep order
  return Array.from(new Set(slugs));
}
