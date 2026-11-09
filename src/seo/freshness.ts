export interface DatedArticle {
  slug: string;
  pubDate: string;
  updatedDate?: string;
}

/** Articles not touched for `days` days, oldest first. Stale content loses rankings and AI citations. */
export function staleArticles(items: DatedArticle[], now: Date, days = 180): { slug: string; ageDays: number }[] {
  return items
    .map((a) => ({ slug: a.slug, ageDays: Math.floor((now.getTime() - new Date(a.updatedDate ?? a.pubDate).getTime()) / 86_400_000) }))
    .filter((a) => a.ageDays >= days)
    .sort((a, b) => b.ageDays - a.ageDays);
}
