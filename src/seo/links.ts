export interface LinkableArticle {
  slug: string;
  url: string;
  keyword: string;
  body: string;
}

export interface LinkSuggestion {
  from: string;
  to: string;
  anchor: string;
}

/** Suggests internal links: where an article mentions another's target keyword without linking to it. */
export function suggestInternalLinks(articles: LinkableArticle[], maxPerArticle = 3): LinkSuggestion[] {
  const out: LinkSuggestion[] = [];
  for (const from of articles) {
    const linked = new Set([...from.body.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]));
    const unlinked = from.body.replace(/\[[^\]]*\]\([^)]*\)/g, ' ');
    let n = 0;
    for (const to of articles) {
      if (to.slug === from.slug || linked.has(to.url) || !to.keyword) continue;
      const re = new RegExp(`\\b${to.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      const m = re.exec(unlinked);
      if (m) {
        out.push({ from: from.slug, to: to.slug, anchor: m[0] });
        if (++n >= maxPerArticle) break;
      }
    }
  }
  return out;
}
