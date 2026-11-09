import { jaccard, tokens } from './text.js';

/** Groups similar keywords so one article targets each group (a "topic cluster"). */
export function clusterKeywords(keywords: string[], threshold = 0.5): string[][] {
  const clusters: { tokens: string[]; items: string[] }[] = [];
  for (const k of keywords) {
    const t = tokens(k);
    const home = clusters.find((c) => jaccard(c.tokens, t) >= threshold);
    if (home) {
      home.items.push(k);
      home.tokens = [...new Set([...home.tokens, ...t])];
    } else clusters.push({ tokens: t, items: [k] });
  }
  return clusters.map((c) => c.items);
}

export interface ArticleRef {
  slug: string;
  title: string;
  keyword: string;
}

/** Pairs of articles that chase the same search and will compete with each other. */
export function findCannibalisation(items: ArticleRef[], threshold = 0.6): { a: string; b: string; similarity: number }[] {
  const out: { a: string; b: string; similarity: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const A = items[i]!;
      const B = items[j]!;
      const s = Math.max(jaccard(tokens(A.keyword), tokens(B.keyword)), jaccard(tokens(A.title), tokens(B.title)));
      if (s >= threshold) out.push({ a: A.slug, b: B.slug, similarity: Math.round(s * 100) / 100 });
    }
  }
  return out;
}
