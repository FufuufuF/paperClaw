import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

export interface ProfileUpdateResult {
  profilePath: string;
  backupPath?: string;
  slug: string;
  created: boolean;
}

export async function updateProfileFromNote(opts: {
  profilePath: string;
  notePath: string;
  slug: string;
  title: string;
  verdict: string;
}): Promise<ProfileUpdateResult> {
  await fs.mkdir(dirname(opts.profilePath), { recursive: true });
  let existing = '';
  let backupPath: string | undefined;
  try {
    existing = await fs.readFile(opts.profilePath, 'utf8');
    backupPath = `${opts.profilePath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fs.writeFile(backupPath, existing, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const link = `[[${opts.slug}]]`;
  const next = ensureProfileSections(existing);
  const entry = `- ${link} ${opts.title} — verdict: ${opts.verdict || 'unknown'}; note: ${opts.notePath}`;
  const updated = existing.includes(link)
    ? replaceReadIndexEntry(next, link, entry)
    : insertUnderReadIndex(next, entry);
  await fs.writeFile(opts.profilePath, updated, 'utf8');
  return { profilePath: opts.profilePath, backupPath, slug: opts.slug, created: !existing.includes(link) };
}

function ensureProfileSections(md: string): string {
  if (md.trim()) {
    let out = md.endsWith('\n') ? md : `${md}\n`;
    if (!/^##\s+已读索引/m.test(out)) out += '\n## 已读索引\n\n';
    if (!/^##\s+用户兴趣推断/m.test(out)) out += '\n## 用户兴趣推断\n\n- 待积累更多精读笔记后更新。\n';
    if (!/^##\s+待问用户/m.test(out)) out += '\n## 待问用户\n\n- 暂无。\n';
    return out;
  }
  return [
    '# paperClaw Profile',
    '',
    '## 已读索引',
    '',
    '## 用户兴趣推断',
    '',
    '- 待积累更多精读笔记后更新。',
    '',
    '## 待问用户',
    '',
    '- 暂无。',
    '',
  ].join('\n');
}

function insertUnderReadIndex(md: string, entry: string): string {
  const lines = md.split('\n');
  const idx = lines.findIndex((line) => /^##\s+已读索引/.test(line));
  if (idx === -1) return `${md.trimEnd()}\n\n## 已读索引\n\n${entry}\n`;
  let insertAt = idx + 1;
  while (insertAt < lines.length && lines[insertAt]!.trim() === '') insertAt++;
  lines.splice(insertAt, 0, entry);
  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n');
}

function replaceReadIndexEntry(md: string, link: string, entry: string): string {
  const lines = md.split('\n');
  let inReadIndex = false;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    if (/^##\s+已读索引/.test(line)) {
      inReadIndex = true;
      continue;
    }
    if (inReadIndex && /^##\s+/.test(line)) break;
    if (inReadIndex && line.includes(link)) {
      lines[idx] = entry;
      return lines.join('\n');
    }
  }
  return insertUnderReadIndex(md, entry);
}
