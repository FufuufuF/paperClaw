import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ExtractedPdfText {
  path: string;
  titleHint: string;
  text: string;
  bytes: number;
  extraction: 'sidecar' | 'pdftotext' | 'ascii';
  sufficient: boolean;
  quality: {
    chars: number;
    words: number;
    reason: string;
  };
}

/**
 * Local PDF text extractor. It prefers a curated sidecar, then uses the
 * system `pdftotext` binary when available, and only falls back to lossy ASCII
 * extraction as a last resort. The caller should refuse to write notes when
 * `sufficient=false`.
 */
export async function extractPdfText(path: string, maxChars = 24_000): Promise<ExtractedPdfText> {
  const sidecar = path.replace(/\.pdf$/i, '.txt');
  try {
    const txt = await fs.readFile(sidecar, 'utf8');
    const st = await fs.stat(path);
    return {
      path,
      titleHint: titleFromPath(path),
      text: cleanText(txt).slice(0, maxChars),
      bytes: st.size,
      extraction: 'sidecar',
      ...qualityFor(cleanText(txt), 'sidecar'),
    };
  } catch {
    // fall through to binary ASCII extraction
  }

  const buf = await fs.readFile(path);
  const pdftotext = await extractWithPdftotext(path, maxChars);
  if (pdftotext) {
    return {
      path,
      titleHint: titleFromPath(path),
      text: pdftotext.text,
      bytes: buf.length,
      extraction: 'pdftotext',
      ...qualityFor(pdftotext.text, 'pdftotext'),
    };
  }

  const raw = buf.toString('latin1');
  const chunks = raw.match(/[A-Za-z0-9][A-Za-z0-9\s.,;:!?()[\]{}'"%/+\-=]{20,}/g) ?? [];
  const text = chunks
    .map((chunk) => cleanText(chunk))
    .filter((chunk) => chunk.length > 30)
    .join('\n')
    .slice(0, maxChars);

  return {
    path,
    titleHint: titleFromPath(path),
    text,
    bytes: buf.length,
    extraction: 'ascii',
    ...qualityFor(text, 'ascii'),
  };
}

function titleFromPath(path: string): string {
  return basename(path).replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim();
}

async function extractWithPdftotext(path: string, maxChars: number): Promise<{ text: string } | null> {
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-raw', path, '-'], {
      timeout: 15_000,
      maxBuffer: Math.max(maxChars * 4, 1024 * 1024),
    });
    const text = cleanText(stdout).slice(0, maxChars);
    return text ? { text } : null;
  } catch {
    return null;
  }
}

function cleanText(text: string): string {
  return text.replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function qualityFor(
  text: string,
  extraction: ExtractedPdfText['extraction'],
): Pick<ExtractedPdfText, 'sufficient' | 'quality'> {
  const chars = text.trim().length;
  const words = (text.match(/[A-Za-z][A-Za-z-]+|[\u4e00-\u9fff]/g) ?? []).length;
  const minChars = extraction === 'sidecar' ? 40 : extraction === 'pdftotext' ? 500 : 800;
  const sufficient = chars >= minChars && words >= 20;
  const reason = sufficient
    ? `${extraction} extracted enough text`
    : `${extraction} extraction too short (${chars} chars, ${words} words)`;
  return {
    sufficient,
    quality: { chars, words, reason },
  };
}
