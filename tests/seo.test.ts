import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import profileJson from '../clients/plerosis.json' with { type: 'json' };
import { parseArticle } from '../src/publish/frontmatter.js';
import { buildSiteArtifacts } from '../src/publish/site.js';
import { CompositeSearch, CrawlSources, FileSources } from '../src/providers/sources.js';
import { auditSite } from '../src/seo/audit.js';
import { clusterKeywords, findCannibalisation } from '../src/seo/cluster.js';
import { crawlSite, type Fetcher } from '../src/seo/crawl.js';
import { buildRobotsTxt, buildRss, buildSitemapXml } from '../src/seo/files.js';
import { staleArticles } from '../src/seo/freshness.js';
import { findOpportunities, parseGscCsv } from '../src/seo/gsc.js';
import { parsePage } from '../src/seo/html.js';
import { suggestInternalLinks } from '../src/seo/links.js';
import { analyseArticle, countSyllables, readingEase } from '../src/seo/onpage.js';
import { renderAuditReport } from '../src/seo/report.js';
import { blocksWholeSite, isPathBlocked, parseRobots } from '../src/seo/robots.js';
import { articleJsonLd, extractFaq, faqJsonLd, renderJsonLdScript } from '../src/seo/schema.js';
import type { ClientProfile } from '../src/types.js';

const profile = profileJson as ClientProfile;
const ORIGIN = 'https://shop.test';

const longText = 'This is a useful sentence about our services and how we help people. '.repeat(40);
const page = (head: string, body: string) =>
  `<!doctype html><html lang="en"><head><title>${head}</title></head><body><main>${body}</main></body></html>`;

function fakeSite(files: Record<string, { status?: number; body?: string; type?: string; location?: string }>): Fetcher {
  return async (url) => {
    const f = files[url];
    if (!f) return { status: 404, body: '', contentType: 'text/html' };
    return { status: f.status ?? 200, body: f.body ?? '', contentType: f.type ?? 'text/html', location: f.location };
  };
}

const goodHead =
  '<meta name="viewport" content="width=device-width"><meta name="description" content="A perfectly sized description for this page that explains what it offers to visitors clearly.">' +
  '<link rel="canonical" href="CANON"><meta property="og:title" content="t"><meta property="og:image" content="i">' +
  '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"X"}</script>';

function goodPage(title: string, canon: string, links: string, extra = '') {
  return `<!doctype html><html lang="en"><head><title>${title}</title>${goodHead.replace('CANON', canon)}</head><body><main><h1>${title}</h1><p>${longText}</p>${links}${extra}</main></body></html>`;
}

describe('robots.txt', () => {
  const r = parseRobots('User-agent: *\nDisallow: /private\n\nUser-agent: GPTBot\nDisallow: /\n\nSitemap: https://x.test/sitemap.xml');
  it('parses groups and sitemaps', () => {
    expect(r.sitemaps).toEqual(['https://x.test/sitemap.xml']);
    expect(r.groups).toHaveLength(2);
  });
  it('knows who is blocked from everything', () => {
    expect(blocksWholeSite(r, 'GPTBot')).toBe(true);
    expect(blocksWholeSite(r, 'ClaudeBot')).toBe(false);
    expect(isPathBlocked(r, 'Googlebot', '/private/a')).toBe(true);
    expect(isPathBlocked(r, 'Googlebot', '/public')).toBe(false);
  });
  it('treats Disallow: / for * as a full block', () => {
    expect(blocksWholeSite(parseRobots('User-agent: *\nDisallow: /'), 'Googlebot')).toBe(true);
  });
});

describe('page parsing', () => {
  it('extracts the SEO-relevant fields', () => {
    const p = parsePage(
      `${ORIGIN}/a`,
      200,
      goodPage('A fine title for this page here', `${ORIGIN}/a`, `<a href="/b">b</a><a href="https://other.test/x" rel="nofollow">x</a><img src="i.png">`),
    );
    expect(p.title).toContain('A fine title');
    expect(p.h1).toHaveLength(1);
    expect(p.viewport).toBe(true);
    expect(p.jsonLdTypes).toEqual(['Organization']);
    expect(p.links.find((l) => l.href === `${ORIGIN}/b`)?.internal).toBe(true);
    expect(p.links.find((l) => l.href.startsWith('https://other'))?.nofollow).toBe(true);
    expect(p.images[0]?.alt).toBeNull();
    expect(p.wordCount).toBeGreaterThan(300);
  });
});

describe('site audit (offline)', () => {
  const home = goodPage('Home page title that is long enough ok', `${ORIGIN}/`, '<a href="/about">About</a><a href="/missing">Gone</a><a href="/old">Old</a><a href="/thin">Thin</a>');
  const fetcher = fakeSite({
    [`${ORIGIN}/robots.txt`]: { body: 'User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\nSitemap: https://shop.test/sitemap.xml', type: 'text/plain' },
    [`${ORIGIN}/sitemap.xml`]: {
      body: `<urlset><url><loc>${ORIGIN}/</loc></url><url><loc>${ORIGIN}/about</loc></url><url><loc>${ORIGIN}/lonely</loc></url><url><loc>${ORIGIN}/gone-in-sitemap</loc></url></urlset>`,
      type: 'application/xml',
    },
    [`${ORIGIN}/`]: { body: home },
    [`${ORIGIN}/about`]: { body: page('', '<p>Short.</p>') },
    [`${ORIGIN}/lonely`]: { body: goodPage('Lonely page nobody links to at all', `${ORIGIN}/lonely`, '') },
    [`${ORIGIN}/old`]: { status: 301, location: '/new' },
    [`${ORIGIN}/new`]: { status: 301, location: '/newer' },
    [`${ORIGIN}/newer`]: { body: goodPage('Newer page after two redirects ok', `${ORIGIN}/newer`, '') },
    [`${ORIGIN}/thin`]: { body: `<html lang="en"><head><title>Thin page title that is fine here ok</title><meta name="robots" content="noindex"></head><body><h1>a</h1><h1>b</h1><p>few words</p></body></html>` },
  });

  it('finds the big problems', async () => {
    const result = auditSite(await crawlSite(`${ORIGIN}/`, fetcher));
    const ids = new Set(result.issues.map((i) => i.id));
    for (const id of [
      'robots-blocks-all', 'ai-crawlers-blocked', 'no-llms-txt', 'broken-link', 'sitemap-url-error',
      'redirect-chain', 'title-missing', 'meta-missing', 'h1-missing', 'viewport-missing', 'thin-content',
      'noindex', 'h1-multiple', 'orphan-page', 'no-structured-data', 'canonical-missing',
    ]) {
      expect(ids, id).toContain(id);
    }
    expect(result.issues.find((i) => i.id === 'robots-blocks-all')?.severity).toBe('critical');
    expect(result.score).toBeLessThan(60);
  });

  it('renders a readable report', async () => {
    const md = renderAuditReport(auditSite(await crawlSite(`${ORIGIN}/`, fetcher)));
    expect(md).toContain('# SEO audit: https://shop.test');
    expect(md).toContain('## Critical');
    expect(md).toContain('**Fix:**');
  });

  it('gives a clean site a high score', async () => {
    const clean = fakeSite({
      [`${ORIGIN}/robots.txt`]: { body: `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml`, type: 'text/plain' },
      [`${ORIGIN}/sitemap.xml`]: { body: `<urlset><url><loc>${ORIGIN}/</loc></url><url><loc>${ORIGIN}/a</loc></url></urlset>`, type: 'application/xml' },
      [`${ORIGIN}/llms.txt`]: { body: '# x', type: 'text/plain' },
      [`${ORIGIN}/`]: { body: goodPage('A clean home page title that works', `${ORIGIN}/`, '<a href="/a">A</a>') },
      [`${ORIGIN}/a`]: { body: goodPage('A clean second page title that works', `${ORIGIN}/a`, '<a href="/">Home</a>') },
    });
    const result = auditSite(await crawlSite(`${ORIGIN}/`, clean));
    expect(result.issues.filter((i) => i.severity === 'critical' || i.severity === 'high')).toEqual([]);
    expect(result.score).toBeGreaterThanOrEqual(90);
  });
});

describe('on-page analysis', () => {
  const body = [
    'Plain English AI automation helps small teams save time. It does the boring work so people can do the rest.',
    '## What AI automation for small business means',
    'Short sentences help. They are easy to read. See [a source](https://example.org/x).',
    '## Next steps',
    'Do one thing first.',
  ].join('\n\n');
  const base = { title: 'AI automation for small business, explained', description: 'How AI automation for small business works, in plain English, with first steps.', slug: 'ai-automation-for-small-business', keyword: 'AI automation for small business', body };

  it('is happy with well-placed keywords', () => {
    const r = analyseArticle(base);
    expect(r.issues).toEqual([]);
    expect(r.warnings.filter((w) => /keyword/i.test(w))).toEqual([]);
  });
  it('warns about missing keyword placement and stuffing', () => {
    const r = analyseArticle({ ...base, title: 'Something else', slug: 'other', description: 'x'.repeat(80) });
    expect(r.warnings.join(' ')).toMatch(/not in the title/);
    const stuffed = analyseArticle({ ...base, body: `${'AI automation for small business. '.repeat(60)}\n\n## A\n\nx` });
    expect(stuffed.warnings.join(' ')).toMatch(/stuffing/);
  });
  it('blocks an H1 in the body and images without alt', () => {
    const r = analyseArticle({ ...base, body: `# Title\n\n![](a.png)\n\n${body}` });
    expect(r.issues.join(' ')).toMatch(/H1/);
    expect(r.issues.join(' ')).toMatch(/alt text/);
  });
  it('measures readability', () => {
    expect(countSyllables('automation')).toBe(4);
    expect(readingEase('The cat sat. The dog ran. We had fun today.').score).toBeGreaterThan(80);
    expect(readingEase('Notwithstanding considerable organisational heterogeneity, implementation necessitates comprehensive interdepartmental coordination.').score).toBeLessThan(20);
  });
});

describe('structured data', () => {
  const md = '## Intro\n\nText.\n\n## Frequently asked questions\n\n**What is it?** A thing that helps.\n\n**Why use it?** It saves time.\n';
  it('extracts FAQ pairs in both styles', () => {
    expect(extractFaq(md)).toEqual([
      { question: 'What is it?', answer: 'A thing that helps.' },
      { question: 'Why use it?', answer: 'It saves time.' },
    ]);
    expect(extractFaq('## FAQ\n\n### Is it free?\n\nYes.\n\n### Is it fast?\n\nVery.')).toHaveLength(2);
    expect(faqJsonLd([])).toBeNull();
  });
  it('builds valid Article JSON-LD and escapes script-breaking text', () => {
    const j = articleJsonLd({ title: 'T', description: 'D', url: 'https://x.test/a', datePublished: '2026-11-09', authorName: 'A', publisherName: 'P', publisherUrl: 'https://x.test' });
    expect(j['@type']).toBe('Article');
    expect(renderJsonLdScript({ a: '</script><b>' })).not.toContain('</script><b>');
  });
});

describe('generated site files', () => {
  it('builds sitemap, robots and rss', () => {
    expect(buildSitemapXml([{ loc: 'https://x.test/a?b=1&c=2', lastmod: '2026-11-09' }])).toContain('&amp;c=2');
    const r = buildRobotsTxt({ sitemapUrl: 'https://x.test/sitemap.xml', allowAiCrawlers: true });
    expect(r).toContain('User-agent: GPTBot\nAllow: /');
    expect(blocksWholeSite(parseRobots(buildRobotsTxt({ sitemapUrl: 's', allowAiCrawlers: false })), 'GPTBot')).toBe(true);
    expect(buildRobotsTxt({ sitemapUrl: 's', allowAiCrawlers: true, blockAll: true })).toBe('User-agent: *\nDisallow: /\n');
    expect(buildRss({ title: 't', link: 'https://x.test', description: 'd', items: [{ title: 'a & b', link: 'https://x.test/a', description: 'x', pubDate: '2026-11-09' }] })).toContain('a &amp; b');
  });

  it('builds the full set for published articles only', () => {
    const mk = (status: string, pub: string) => ({
      title: 'AI agents for business explained',
      description: 'A plain explanation of AI agents for business with a human in the loop and clear first steps.',
      pubDate: pub, tags: [], status,
      body: '## A\n\nx\n\n## Frequently asked questions\n\n**Q one?** Answer one.',
    });
    const out = buildSiteArtifacts(
      profile,
      [
        { slug: 'live-one', article: mk('published', '2026-11-01'), keyword: 'AI agents for business' },
        { slug: 'draft-one', article: mk('draft', '2026-11-02'), keyword: 'something unrelated entirely' },
      ],
      { now: new Date('2026-11-09') },
    );
    expect(out.files['sitemap.xml']).toContain('/blog/live-one');
    expect(out.files['sitemap.xml']).not.toContain('draft-one');
    expect(out.files['llms.txt']).toContain('live-one');
    expect(Object.keys(out.files)).toContain('schema/live-one.json');
    expect(out.files['schema/live-one.json']).toContain('FAQPage');
    expect(out.report.join('\n')).toMatch(/Overlap/);
  });

  it('round-trips front matter written by the engine', () => {
    const a = parseArticle('---\ntitle: "Hello: world"\ndescription: "D"\npubDate: 2026-11-09\ntags: ["a"]\nstatus: draft\n---\nBody text');
    expect(a).toMatchObject({ title: 'Hello: world', pubDate: '2026-11-09', tags: ['a'], status: 'draft', body: 'Body text' });
  });
});

describe('search console and strategy', () => {
  const csv = 'Top queries,Clicks,Impressions,CTR,Position\n"ai agents, small business",3,400,0.75%,11.2\nbook a demo,1,300,0.3%,3.1\nai consultancy uk,0,200,0%,35\ntiny,1,5,20%,2\n';
  it('parses the export and finds opportunities', () => {
    const rows = parseGscCsv(csv);
    expect(rows[0]).toMatchObject({ query: 'ai agents, small business', impressions: 400, position: 11.2 });
    expect(rows[0]!.ctr).toBeCloseTo(0.0075);
    const o = findOpportunities(rows);
    expect(o.strikingDistance.map((r) => r.query)).toEqual(['ai agents, small business']);
    expect(o.lowCtr.map((r) => r.query)).toEqual(['book a demo']);
    expect(o.contentGaps.map((r) => r.query)).toEqual(['ai consultancy uk']);
  });
  it('clusters keywords and finds cannibalisation', () => {
    expect(clusterKeywords(['AI agents for business', 'AI agent for businesses', 'pricing page design'])).toHaveLength(2);
    const pairs = findCannibalisation([
      { slug: 'a', title: 'How AI agents help business', keyword: 'ai agents for business' },
      { slug: 'b', title: 'AI agents for businesses guide', keyword: 'ai agent for business' },
      { slug: 'c', title: 'Local SEO checklist', keyword: 'local seo' },
    ]);
    expect(pairs.map((p) => `${p.a}-${p.b}`)).toEqual(['a-b']);
  });
  it('suggests internal links and finds stale articles', () => {
    const s = suggestInternalLinks([
      { slug: 'a', url: '/blog/a', keyword: 'ai agents', body: 'We use workflow automation daily.' },
      { slug: 'b', url: '/blog/b', keyword: 'workflow automation', body: 'Our ai agents are great.' },
    ]);
    expect(s).toEqual([
      { from: 'a', to: 'b', anchor: 'workflow automation' },
      { from: 'b', to: 'a', anchor: 'ai agents' },
    ]);
    expect(suggestInternalLinks([{ slug: 'a', url: '/blog/a', keyword: 'x y', body: 'z' }, { slug: 'b', url: '/blog/b', keyword: 'q', body: 'see [x y](/blog/a) and x y' }])).toEqual([]);
    expect(staleArticles([{ slug: 'old', pubDate: '2025-01-01' }, { slug: 'new', pubDate: '2026-11-01' }], new Date('2026-11-09'))).toEqual([{ slug: 'old', ageDays: 677 }]);
  });
});

describe('free research sources', () => {
  it('finds the best passages in your own notes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'src-'));
    await writeFile(join(dir, 'meeting.md'), '# Car wash meeting\n\nThe owner said bookings by phone take about twenty minutes of staff time every single day.\n\nWe agreed a membership scheme would reduce queueing at the weekend significantly.');
    await writeFile(join(dir, 'other.txt'), 'Completely unrelated notes about gardening and the weather in spring this year, nothing else.');
    const res = await new FileSources(dir).search('car wash membership scheme queueing', 3);
    expect(res[0]?.title).toBe('Car wash meeting');
    expect(res[0]?.url).toBe('supplied://meeting.md');
    expect(res[0]?.snippet).toContain('membership scheme');
    expect(res.some((r) => r.url === 'supplied://other.txt')).toBe(false);
  });
  it('uses the client site as a source and merges providers', async () => {
    const fetcher = fakeSite({
      [`${ORIGIN}/`]: { body: goodPage('Home', `${ORIGIN}/`, '', '<p>We run a membership scheme for regular customers so queueing drops at the weekend and staff time is saved every day.</p>') },
    });
    const site = await crawlSite(`${ORIGIN}/`, fetcher);
    const merged = new CompositeSearch([new FileSources('/does/not/exist'), new CrawlSources(site)]);
    const res = await merged.search('membership scheme queueing', 3);
    expect(res[0]?.url).toBe(`${ORIGIN}/`);
  });
});
