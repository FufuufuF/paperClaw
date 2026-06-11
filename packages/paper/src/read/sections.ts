export interface PaperSection {
  index: number;
  title: string;
  text: string;
  chars: number;
}

const MAX_SECTION_CHARS = 14_000;

const KNOWN_UNNUMBERED = /^(abstract|introduction|related work|background|method|methods|approach|framework|experiments?|evaluation|results?|analysis|discussion|limitations?|conclusion|references|bibliography|appendix)$/i;
const NUMBERED_HEADING = /^\d+(?:\.\d+)*\s+\p{Lu}[\p{L}\p{N} ,&:/()'’+\-?.]{2,90}$/u;

export function inferTitleFromText(text: string, fallback: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines.slice(0, 20)) {
    if (line.length < 8 || line.length > 180) continue;
    if (/^arxiv:/i.test(line) || /^abstract$/i.test(line)) continue;
    if (/^(figure|table)\s+\d+/i.test(line)) continue;
    if (/^\d+(?:\.\d+)*\s+/.test(line)) continue;
    return line;
  }
  return fallback;
}

export function splitPaperSections(text: string): PaperSection[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const starts = headingStarts(lines);

  if (starts.length === 0) {
    return chunkSection({ index: 1, title: 'Full Text Excerpt', text: normalized.trim() });
  }

  const sections: PaperSection[] = [];
  for (let pos = 0; pos < starts.length; pos++) {
    const start = starts[pos]!;
    const title = cleanHeading(lines[start] ?? `Section ${pos + 1}`);
    if (/^(references|bibliography)$/i.test(stripNumber(title))) break;
    const end = starts[pos + 1] ?? lines.length;
    const sectionText = lines.slice(start, end).join('\n').trim();
    if (!sectionText) continue;
    const nextTitle = starts[pos + 1] !== undefined ? cleanHeading(lines[starts[pos + 1]!] ?? '') : '';
    if (sectionText.length < 120 && isParentHeading(title, nextTitle)) continue;
    sections.push(...chunkSection({ index: sections.length + 1, title, text: sectionText }));
  }

  return sections.length > 0
    ? sections.map((section, idx) => ({ ...section, index: idx + 1 }))
    : chunkSection({ index: 1, title: 'Full Text Excerpt', text: normalized.trim() });
}

function headingStarts(lines: string[]): number[] {
  const starts: number[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!.trim();
    if (!isLikelyHeading(line)) continue;
    if (idx > 0 && looksLikeSentenceContinuation(lines[idx - 1]!)) continue;
    starts.push(idx);
  }
  return starts;
}

function isLikelyHeading(line: string): boolean {
  if (!line || line.length > 120) return false;
  if (/^(figure|table)\s+\d+/i.test(line)) return false;
  if (/^\d+$/.test(line)) return false;
  if (KNOWN_UNNUMBERED.test(line)) return true;
  return NUMBERED_HEADING.test(line);
}

function looksLikeSentenceContinuation(line: string): boolean {
  return /[,;:]$/.test(line.trim());
}

function cleanHeading(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

function stripNumber(title: string): string {
  return title.replace(/^\d+(?:\.\d+)*\s+/, '').trim();
}

function isParentHeading(title: string, nextTitle: string): boolean {
  const match = /^(\d+)\s+/.exec(title);
  return Boolean(match && nextTitle.startsWith(`${match[1]}.`));
}

function chunkSection(section: { index: number; title: string; text: string }): PaperSection[] {
  if (section.text.length <= MAX_SECTION_CHARS) {
    return [{ ...section, chars: section.text.length }];
  }

  const chunks: PaperSection[] = [];
  let rest = section.text;
  let part = 1;
  while (rest.length > 0) {
    let cut = rest.lastIndexOf('\n\n', MAX_SECTION_CHARS);
    if (cut < MAX_SECTION_CHARS * 0.5) cut = rest.lastIndexOf('\n', MAX_SECTION_CHARS);
    if (cut < MAX_SECTION_CHARS * 0.5) cut = Math.min(MAX_SECTION_CHARS, rest.length);
    const text = rest.slice(0, cut).trim();
    if (text) {
      chunks.push({
        index: section.index,
        title: `${section.title} (part ${part})`,
        text,
        chars: text.length,
      });
      part++;
    }
    rest = rest.slice(cut).trim();
  }
  return chunks;
}
