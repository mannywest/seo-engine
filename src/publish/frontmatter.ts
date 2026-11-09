export interface ParsedArticle {
  title: string;
  description: string;
  pubDate: string;
  updatedDate?: string;
  tags: string[];
  status: string;
  body: string;
}

/** Reads the simple front matter that seo-engine writes (JSON-style quoted strings and arrays). */
export function parseArticle(markdown: string): ParsedArticle {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(markdown);
  if (!m) throw new Error('Article has no front matter.');
  const front: Record<string, string> = {};
  for (const line of (m[1] ?? '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) front[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const str = (k: string) => {
    const v = front[k];
    if (v === undefined) return '';
    try {
      const p = JSON.parse(v);
      return typeof p === 'string' ? p : String(p);
    } catch {
      return v;
    }
  };
  let tags: string[] = [];
  try {
    tags = JSON.parse(front.tags ?? '[]');
  } catch {
    /* ignore */
  }
  return {
    title: str('title'),
    description: str('description'),
    pubDate: str('pubDate'),
    updatedDate: front.updatedDate ? str('updatedDate') : undefined,
    tags,
    status: str('status') || 'draft',
    body: (m[2] ?? '').trim(),
  };
}
