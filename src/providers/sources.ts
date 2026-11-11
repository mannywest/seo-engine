import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SiteSnapshot } from '../seo/crawl.js';
import { tokens } from '../seo/text.js';
import type { Source } from '../types.js';
import type { SearchProvider } from './search.js';

interface Doc {
  title: string;
  url: string;
  paragraphs: string[];
}

function toParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.split(' ').length >= 6);
}

/** Ranks documents by how well their paragraphs match the query (term overlap weighted by rarity). */
export function rankDocs(docs: Doc[], query: string, limit: number, snippetChars = 700): Source[] {
  const q = tokens(query);
  if (!q.length) return [];
  const df = new Map<string, number>();
  for (const d of docs) {
    const set = new Set(d.paragraphs.flatMap((p) => tokens(p)));
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = (t: string) => Math.log(1 + docs.length / (1 + (df.get(t) ?? 0)));
  const scored: { doc: Doc; score: number; best: string[] }[] = [];
  for (const doc of docs) {
    const ps = doc.paragraphs
      .map((p) => {
        const pt = new Set(tokens(p));
        return { p, s: q.reduce((n, t) => n + (pt.has(t) ? idf(t) : 0), 0) };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    if (!ps.length) continue;
    scored.push({ doc, score: ps.slice(0, 3).reduce((n, x) => n + x.s, 0), best: ps.slice(0, 3).map((x) => x.p) });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ doc, best }) => ({ title: doc.title, url: doc.url, snippet: best.join(' ').slice(0, snippetChars), fullText: doc.paragraphs.join(' ') }));
}

/** Your own notes: any .md or .txt files in a folder (case notes, transcripts, service descriptions). */
export class FileSources implements SearchProvider {
  readonly name = 'supplied-files';
  constructor(private dir: string) {}
  async search(query: string, limit: number): Promise<Source[]> {
    let files: string[] = [];
    try {
      files = (await readdir(this.dir)).filter((f) => /\.(md|txt)$/i.test(f));
    } catch {
      return [];
    }
    const docs: Doc[] = [];
    for (const f of files) {
      const text = await readFile(join(this.dir, f), 'utf8');
      const heading = /^#\s+(.+)$/m.exec(text)?.[1];
      docs.push({ title: heading ?? f, url: `supplied://${f}`, paragraphs: toParagraphs(text) });
    }
    return rankDocs(docs, query, limit);
  }
}

/** The client's own published pages, from a crawl. Real URLs, so they can be cited. */
export class CrawlSources implements SearchProvider {
  readonly name = 'own-site';
  private docs: Doc[];
  constructor(site: SiteSnapshot) {
    this.docs = [...site.pages.values()]
      .filter((p) => p.isHtml && p.status === 200 && p.wordCount > 80)
      .map((p) => ({ title: p.title || p.url, url: p.url, paragraphs: toParagraphs(p.text.replace(/([.!?])\s+/g, '$1\n\n')) }));
  }
  async search(query: string, limit: number): Promise<Source[]> {
    return rankDocs(this.docs, query, limit);
  }
}

/** Merges several providers, de-duplicating by URL. A failing provider is skipped, not fatal. */
export class CompositeSearch implements SearchProvider {
  readonly name = 'composite';
  constructor(private providers: SearchProvider[]) {}
  async search(query: string, limit: number): Promise<Source[]> {
    const byUrl = new Map<string, Source>();
    for (const p of this.providers) {
      const res = await p.search(query, limit).catch(() => []);
      for (const s of res) if (!byUrl.has(s.url)) byUrl.set(s.url, s);
    }
    return [...byUrl.values()].slice(0, limit);
  }
}
