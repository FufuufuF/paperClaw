import { XMLParser } from 'fast-xml-parser';
import { withRetry } from '@paperclaw/core';

/**
 * Single arXiv search result. Matches plan F1: arxiv_id / title / authors /
 * year / abstract.
 */
export interface ArxivCandidate {
  arxiv_id: string;       // e.g. "2401.12345" or "cs/0506075"
  title: string;
  authors: string[];
  year: number;
  abstract: string;
  pdf_url: string;
  published: string;      // ISO date
}

interface ArxivEntry {
  id: string;
  title: string;
  summary: string;
  published: string;
  author?: { name: string } | { name: string }[];
  link?: { '@_href': string; '@_title'?: string; '@_rel'?: string } | Array<{ '@_href': string; '@_title'?: string; '@_rel'?: string }>;
}

interface ArxivFeed {
  feed?: {
    entry?: ArxivEntry | ArxivEntry[];
  };
}

const ARXIV_ENDPOINT = 'http://export.arxiv.org/api/query';

/**
 * Hit arXiv's Atom-feed search API. We use `all:` so the term matches title /
 * abstract / etc — narrower fields like `ti:` cut recall too hard for the
 * triage downstream to recover.
 *
 * arXiv recommends ≥3s between requests; we add a retry-with-backoff for
 * 5xx, and the caller (query_flow / cron_flow) bounds concurrency.
 */
export async function searchArxiv(query: string, maxN = 30): Promise<ArxivCandidate[]> {
  const params = new URLSearchParams({
    search_query: `all:${query}`,
    start: '0',
    max_results: String(Math.max(1, Math.min(200, maxN))),
    sortBy: 'relevance',
    sortOrder: 'descending',
  });
  const url = `${ARXIV_ENDPOINT}?${params.toString()}`;

  const xml = await withRetry(
    async () => {
      const res = await fetch(url, {
        headers: {
          // arXiv asks for a UA in their docs
          'User-Agent': 'paperClaw/0.1 (https://github.com/FufuufuF/paperClaw)',
        },
      });
      if (!res.ok) {
        const err = new Error(`arXiv ${res.status}`);
        (err as Error & { transient?: boolean }).transient = res.status >= 500 || res.status === 429;
        throw err;
      }
      return await res.text();
    },
    { tries: 3, baseMs: 1500 },
  );

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: true,
  });
  const parsed = parser.parse(xml) as ArxivFeed;
  const entriesRaw = parsed.feed?.entry;
  if (!entriesRaw) return [];
  const entries = Array.isArray(entriesRaw) ? entriesRaw : [entriesRaw];

  return entries.map(parseEntry).filter((c): c is ArxivCandidate => c !== null);
}

function parseEntry(e: ArxivEntry): ArxivCandidate | null {
  // id is like http://arxiv.org/abs/2401.12345v1 — strip the version
  const idMatch = /arxiv\.org\/abs\/(.+)$/.exec(e.id ?? '');
  if (!idMatch) return null;
  const arxiv_id = idMatch[1]!.replace(/v\d+$/, '');

  const authorsRaw = e.author;
  const authors = Array.isArray(authorsRaw)
    ? authorsRaw.map((a) => a.name).filter(Boolean)
    : authorsRaw?.name
    ? [authorsRaw.name]
    : [];

  const linksRaw = e.link;
  const links = Array.isArray(linksRaw) ? linksRaw : linksRaw ? [linksRaw] : [];
  const pdfLink =
    links.find((l) => l['@_title'] === 'pdf')?.['@_href'] ??
    `http://arxiv.org/pdf/${arxiv_id}.pdf`;

  const year = e.published ? new Date(e.published).getUTCFullYear() : 0;

  return {
    arxiv_id,
    title: collapseWhitespace(e.title ?? ''),
    authors,
    year,
    abstract: collapseWhitespace(e.summary ?? ''),
    pdf_url: pdfLink,
    published: e.published ?? '',
  };
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
