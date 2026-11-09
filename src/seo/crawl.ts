import { emptyPage, normaliseUrl, parsePage, type PageData } from './html.js';
import { parseRobots, type Robots } from './robots.js';

export interface FetchResult {
  status: number;
  body: string;
  contentType: string;
  location?: string;
}

/** Injectable so the crawler can be tested offline. It must NOT follow redirects itself. */
export type Fetcher = (url: string) => Promise<FetchResult>;

export const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, {
    redirect: 'manual',
    headers: { 'user-agent': 'seo-engine-audit/0.1 (+site owner audit)' },
    signal: AbortSignal.timeout(15000),
  });
  const contentType = res.headers.get('content-type') ?? '';
  const textual = /text|xml|json|html/.test(contentType) || res.status >= 300;
  return {
    status: res.status,
    body: textual ? await res.text() : '',
    contentType,
    location: res.headers.get('location') ?? undefined,
  };
};

export interface SiteSnapshot {
  origin: string;
  startUrl: string;
  pages: Map<string, PageData>;
  robotsTxt: string | null;
  robots: Robots;
  sitemapUrls: string[];
  sitemapMissing: boolean;
  llmsTxtFound: boolean;
  /** url -> set of internal pages linking to it */
  inbound: Map<string, Set<string>>;
}

async function fetchFollowing(url: string, fetcher: Fetcher, maxHops = 5) {
  const chain: string[] = [];
  let current = url;
  for (let i = 0; i <= maxHops; i++) {
    const res = await fetcher(current);
    if (res.status >= 300 && res.status < 400 && res.location) {
      const next = normaliseUrl(res.location, current);
      if (!next) return { res, finalUrl: current, chain };
      chain.push(next);
      current = next;
      continue;
    }
    return { res, finalUrl: current, chain };
  }
  return { res: { status: 310, body: '', contentType: '' } as FetchResult, finalUrl: current, chain };
}

function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi)].map((m) => (m[1] ?? '').replace(/&amp;/g, '&'));
}

export async function crawlSite(
  startUrl: string,
  fetcher: Fetcher = defaultFetcher,
  opts: { maxPages?: number } = {},
): Promise<SiteSnapshot> {
  const maxPages = opts.maxPages ?? 100;
  const start = normaliseUrl(startUrl)!;
  const origin = new URL(start).origin;

  const robotsRes = await fetcher(`${origin}/robots.txt`).catch(() => null);
  const robotsTxt = robotsRes && robotsRes.status === 200 ? robotsRes.body : null;
  const robots = parseRobots(robotsTxt ?? '');

  const sitemapCandidates = robots.sitemaps.length ? robots.sitemaps : [`${origin}/sitemap.xml`];
  const sitemapUrls: string[] = [];
  let sitemapFound = false;
  for (const sm of sitemapCandidates) {
    const res = await fetcher(sm).catch(() => null);
    if (!res || res.status !== 200) continue;
    sitemapFound = true;
    let found = locs(res.body);
    if (/<sitemapindex/i.test(res.body)) {
      const nested: string[] = [];
      for (const child of found.slice(0, 20)) {
        const r = await fetcher(child).catch(() => null);
        if (r && r.status === 200) nested.push(...locs(r.body));
      }
      found = nested;
    }
    sitemapUrls.push(...found.map((u) => normaliseUrl(u) ?? u));
  }

  const llmsRes = await fetcher(`${origin}/llms.txt`).catch(() => null);

  const pages = new Map<string, PageData>();
  const inbound = new Map<string, Set<string>>();
  const queue: string[] = [start, ...sitemapUrls.filter((u) => u.startsWith(origin))];
  const seen = new Set<string>();

  while (queue.length && pages.size < maxPages) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    let page: PageData;
    try {
      const { res, finalUrl, chain } = await fetchFollowing(url, fetcher);
      if (res.status >= 200 && res.status < 300 && /html/i.test(res.contentType || 'text/html')) {
        page = parsePage(finalUrl, res.status, res.body, chain);
        page.url = url; // keep the URL we asked for; chain shows where it ended
      } else {
        page = emptyPage(url, res.status, chain);
      }
    } catch {
      page = emptyPage(url, 0);
    }
    pages.set(url, page);
    for (const l of page.links) {
      if (!l.internal) continue;
      if (!inbound.has(l.href)) inbound.set(l.href, new Set());
      inbound.get(l.href)!.add(url);
      if (!seen.has(l.href)) queue.push(l.href);
    }
  }

  return {
    origin, startUrl: start, pages, robotsTxt, robots, sitemapUrls,
    sitemapMissing: !sitemapFound, llmsTxtFound: llmsRes?.status === 200, inbound,
  };
}
