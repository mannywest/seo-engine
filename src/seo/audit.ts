import type { PageData } from './html.js';
import type { SiteSnapshot } from './crawl.js';
import { AI_CRAWLERS, blocksWholeSite } from './robots.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Category = 'crawl' | 'indexing' | 'on-page' | 'content' | 'structured-data' | 'ai-search' | 'links' | 'mobile';

export interface Issue {
  id: string;
  severity: Severity;
  category: Category;
  url?: string;
  message: string;
  fix: string;
}

export interface AuditResult {
  origin: string;
  pagesCrawled: number;
  issues: Issue[];
  score: number;
  counts: Record<Severity, number>;
}

const WEIGHT: Record<Severity, number> = { critical: 25, high: 10, medium: 4, low: 1 };

function dupes(pages: PageData[], pick: (p: PageData) => string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const p of pages) {
    const v = pick(p).trim().toLowerCase();
    if (!v) continue;
    m.set(v, [...(m.get(v) ?? []), p.url]);
  }
  return new Map([...m].filter(([, urls]) => urls.length > 1));
}

/** Runs every technical, on-page, structured-data and AI-search rule against a crawl. Pure: no network. */
export function auditSite(site: SiteSnapshot): AuditResult {
  const issues: Issue[] = [];
  const add = (i: Issue) => issues.push(i);
  const all = [...site.pages.values()];
  const html = all.filter((p) => p.isHtml && p.status === 200);
  const sitemapSet = new Set(site.sitemapUrls);

  // ---- Site level: crawl and indexing ----
  if (!site.origin.startsWith('https://')) {
    add({ id: 'not-https', severity: 'high', category: 'crawl', message: 'The site is not served over HTTPS.', fix: 'Install a certificate and redirect all HTTP traffic to HTTPS.' });
  }
  if (site.robotsTxt === null) {
    add({ id: 'no-robots-txt', severity: 'medium', category: 'crawl', message: 'No robots.txt found.', fix: 'Add /robots.txt that allows crawling and points to your sitemap.' });
  } else if (blocksWholeSite(site.robots, '*')) {
    add({ id: 'robots-blocks-all', severity: 'critical', category: 'indexing', message: 'robots.txt blocks all crawlers from the whole site (Disallow: /). Search engines cannot index it.', fix: 'Remove "Disallow: /" for User-agent: * when you are ready for search traffic.' });
  }
  if (site.sitemapMissing) {
    add({ id: 'no-sitemap', severity: 'high', category: 'indexing', message: 'No XML sitemap found.', fix: 'Publish /sitemap.xml and reference it in robots.txt.' });
  } else if (site.robotsTxt !== null && site.robots.sitemaps.length === 0) {
    add({ id: 'sitemap-not-in-robots', severity: 'low', category: 'indexing', message: 'robots.txt does not list the sitemap.', fix: 'Add a "Sitemap: https://.../sitemap.xml" line.' });
  }
  const blockedAi = AI_CRAWLERS.filter((a) => blocksWholeSite(site.robots, a));
  if (blockedAi.length) {
    add({ id: 'ai-crawlers-blocked', severity: 'medium', category: 'ai-search', message: `These AI crawlers are blocked: ${blockedAi.join(', ')}.`, fix: 'Allow them in robots.txt if you want AI assistants to be able to read and cite the site.' });
  }
  if (!site.llmsTxtFound) {
    add({ id: 'no-llms-txt', severity: 'low', category: 'ai-search', message: 'No /llms.txt file (a proposed convention; AI search engines have not confirmed they use it).', fix: 'Publish a short llms.txt that lists your key pages and articles.' });
  }

  // ---- Sitemap hygiene ----
  for (const u of site.sitemapUrls) {
    const p = site.pages.get(u);
    if (p && p.status >= 400) {
      add({ id: 'sitemap-url-error', severity: 'high', category: 'indexing', url: u, message: `Sitemap lists a URL that returns ${p.status}.`, fix: 'Remove it from the sitemap or fix the page.' });
    }
  }
  for (const p of html) {
    if (!site.sitemapMissing && !sitemapSet.has(p.url) && !p.robotsMeta.includes('noindex')) {
      add({ id: 'page-not-in-sitemap', severity: 'low', category: 'indexing', url: p.url, message: 'Page is crawlable but not in the sitemap.', fix: 'Add it to the sitemap.' });
    }
    if (p.url !== site.startUrl && (site.inbound.get(p.url)?.size ?? 0) === 0) {
      add({ id: 'orphan-page', severity: 'medium', category: 'links', url: p.url, message: 'No other page links to this one (orphan page).', fix: 'Link to it from a relevant page or the navigation.' });
    }
  }

  // ---- Status codes, redirects, broken links ----
  for (const p of all) {
    if (p.status >= 500 || p.status === 0) {
      add({ id: 'server-error', severity: 'critical', category: 'crawl', url: p.url, message: p.status === 0 ? 'Page could not be fetched.' : `Page returns ${p.status}.`, fix: 'Fix the server error.' });
    } else if (p.status >= 400) {
      const from = [...(site.inbound.get(p.url) ?? [])];
      add({ id: 'broken-link', severity: 'high', category: 'links', url: p.url, message: `Returns ${p.status}${from.length ? `; linked from ${from.slice(0, 3).join(', ')}` : ''}.`, fix: 'Restore the page, redirect it, or update the links pointing to it.' });
    }
    if (p.redirectChain.length > 1) {
      add({ id: 'redirect-chain', severity: 'medium', category: 'crawl', url: p.url, message: `Redirects through ${p.redirectChain.length} hops.`, fix: 'Redirect straight to the final URL.' });
    } else if (p.redirectChain.length === 1 && (site.inbound.get(p.url)?.size ?? 0) > 0) {
      add({ id: 'internal-link-redirects', severity: 'low', category: 'links', url: p.url, message: 'Internal links point to a URL that redirects.', fix: 'Update internal links to the final URL.' });
    }
  }

  // ---- Page level ----
  for (const p of html) {
    const noindex = p.robotsMeta.includes('noindex');
    if (noindex) {
      add({ id: 'noindex', severity: sitemapSet.has(p.url) ? 'high' : 'medium', category: 'indexing', url: p.url, message: 'Page has a noindex directive.', fix: 'Remove noindex if the page should appear in search.' });
    }
    if (!p.title) add({ id: 'title-missing', severity: 'high', category: 'on-page', url: p.url, message: 'Missing <title>.', fix: 'Add a unique title of about 30-60 characters.' });
    else if (p.title.length > 60) add({ id: 'title-long', severity: 'low', category: 'on-page', url: p.url, message: `Title is ${p.title.length} characters and may be truncated in results.`, fix: 'Shorten to about 60 characters.' });
    else if (p.title.length < 30) add({ id: 'title-short', severity: 'low', category: 'on-page', url: p.url, message: `Title is only ${p.title.length} characters.`, fix: 'Use the space to describe the page and its main keyword.' });

    if (!p.description) add({ id: 'meta-missing', severity: 'medium', category: 'on-page', url: p.url, message: 'Missing meta description.', fix: 'Add a unique description of 70-160 characters.' });
    else if (p.description.length > 160 || p.description.length < 70) add({ id: 'meta-length', severity: 'low', category: 'on-page', url: p.url, message: `Meta description is ${p.description.length} characters.`, fix: 'Aim for 70-160 characters.' });

    if (p.h1.length === 0) add({ id: 'h1-missing', severity: 'medium', category: 'on-page', url: p.url, message: 'No H1 heading.', fix: 'Add one H1 that states the page topic.' });
    else if (p.h1.length > 1) add({ id: 'h1-multiple', severity: 'low', category: 'on-page', url: p.url, message: `${p.h1.length} H1 headings.`, fix: 'Use a single H1 and H2s below it.' });

    if (!p.canonical) add({ id: 'canonical-missing', severity: 'low', category: 'indexing', url: p.url, message: 'No canonical link.', fix: 'Add <link rel="canonical"> pointing to this URL.' });
    else if (p.canonical.replace(/\/$/, '') !== p.url.replace(/\/$/, '')) add({ id: 'canonical-elsewhere', severity: 'medium', category: 'indexing', url: p.url, message: `Canonical points to ${p.canonical}.`, fix: 'Check this is intended; otherwise search engines will ignore this page.' });

    if (!p.viewport) add({ id: 'viewport-missing', severity: 'high', category: 'mobile', url: p.url, message: 'No viewport meta tag, so the page is not mobile friendly.', fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.' });
    if (!p.lang) add({ id: 'lang-missing', severity: 'low', category: 'on-page', url: p.url, message: 'No lang attribute on <html>.', fix: 'Add lang="en" (or the right language).' });
    if (p.wordCount < 300 && !noindex) add({ id: 'thin-content', severity: 'medium', category: 'content', url: p.url, message: `Only ${p.wordCount} words.`, fix: 'Add useful content, or consolidate with a stronger page.' });

    const noAlt = p.images.filter((i) => i.alt === null || i.alt.trim() === '').length;
    if (noAlt) add({ id: 'img-alt-missing', severity: 'low', category: 'on-page', url: p.url, message: `${noAlt} image(s) without alt text.`, fix: 'Describe each meaningful image in its alt attribute.' });

    if (!p.og['og:title'] || !p.og['og:image']) add({ id: 'og-missing', severity: 'low', category: 'on-page', url: p.url, message: 'Missing Open Graph title or image (affects link previews).', fix: 'Add og:title, og:description and og:image.' });
    if (p.jsonLdTypes.length === 0) add({ id: 'no-structured-data', severity: 'medium', category: 'structured-data', url: p.url, message: 'No JSON-LD structured data.', fix: 'Add Organization, Article, FAQPage or LocalBusiness markup as appropriate.' });

    const path = new URL(p.url).pathname;
    if (/[A-Z_]/.test(path) || path.length > 115) add({ id: 'url-style', severity: 'low', category: 'on-page', url: p.url, message: 'URL has capitals, underscores or is very long.', fix: 'Use short, lowercase, hyphenated URLs.' });

    if (p.firstParagraph && p.firstParagraph.split(/\s+/).length > 60 && p.wordCount > 400) {
      add({ id: 'answer-first', severity: 'low', category: 'ai-search', url: p.url, message: 'Opening paragraph is long; AI assistants favour short, direct answers near the top.', fix: 'Open with a 2-3 sentence direct answer.' });
    }
  }

  for (const [value, urls] of dupes(html, (p) => p.title)) {
    add({ id: 'title-duplicate', severity: 'medium', category: 'on-page', message: `${urls.length} pages share the title "${value}": ${urls.slice(0, 3).join(', ')}.`, fix: 'Give each page a unique title.' });
  }
  for (const [value, urls] of dupes(html, (p) => p.description)) {
    add({ id: 'meta-duplicate', severity: 'medium', category: 'on-page', message: `${urls.length} pages share a meta description ("${value.slice(0, 50)}..."): ${urls.slice(0, 3).join(', ')}.`, fix: 'Write a unique description for each page.' });
  }

  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const i of issues) counts[i.severity] += 1;
  const penalty = issues.reduce((s, i) => s + WEIGHT[i.severity], 0);
  return { origin: site.origin, pagesCrawled: site.pages.size, issues, counts, score: Math.max(0, 100 - penalty) };
}
