import { AI_CRAWLERS } from './robots.js';

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function buildSitemapXml(entries: { loc: string; lastmod?: string }[]): string {
  const body = entries
    .map((e) => `  <url>\n    <loc>${escapeXml(e.loc)}</loc>${e.lastmod ? `\n    <lastmod>${e.lastmod}</lastmod>` : ''}\n  </url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export interface RobotsOptions {
  sitemapUrl: string;
  /** Allow AI assistants to crawl (so they can cite the site). */
  allowAiCrawlers: boolean;
  /** Keep everything blocked, e.g. for a staging site. */
  blockAll?: boolean;
  disallow?: string[];
}

export function buildRobotsTxt(o: RobotsOptions): string {
  if (o.blockAll) return 'User-agent: *\nDisallow: /\n';
  const lines = ['User-agent: *', ...(o.disallow?.length ? o.disallow.map((d) => `Disallow: ${d}`) : ['Allow: /']), ''];
  for (const bot of AI_CRAWLERS) {
    lines.push(`User-agent: ${bot}`, o.allowAiCrawlers ? 'Allow: /' : 'Disallow: /', '');
  }
  lines.push(`Sitemap: ${o.sitemapUrl}`, '');
  return lines.join('\n');
}

export function buildRss(feed: {
  title: string;
  link: string;
  description: string;
  items: { title: string; link: string; description: string; pubDate: string }[];
}): string {
  const items = feed.items
    .map(
      (i) =>
        `    <item>\n      <title>${escapeXml(i.title)}</title>\n      <link>${escapeXml(i.link)}</link>\n      <guid>${escapeXml(i.link)}</guid>\n      <description>${escapeXml(i.description)}</description>\n      <pubDate>${new Date(i.pubDate).toUTCString()}</pubDate>\n    </item>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n  <channel>\n    <title>${escapeXml(feed.title)}</title>\n    <link>${escapeXml(feed.link)}</link>\n    <description>${escapeXml(feed.description)}</description>\n${items}\n  </channel>\n</rss>\n`;
}
