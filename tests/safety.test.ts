import { describe, expect, it } from 'vitest';
import { crawlSite, type Fetcher } from '../src/seo/crawl.js';
import { assessSafety, renderSafetyReport } from '../src/seo/safety.js';

const ORIGIN = 'https://shop.test';
const html = (title: string, body: string, head = '') => `<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const fake = (files: Record<string, string>): Fetcher => async (url) => {
  const u = url.replace(ORIGIN, '') || '/';
  const body = files[u];
  return body === undefined ? { status: 404, body: '', contentType: 'text/html' } : { status: 200, body, contentType: 'text/html' };
};
const unique = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}x`).join(' ');
const nav = '<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a><a href="/d">d</a><a href="/e">e</a>';
const good = (tag: string) => `<p>${unique(200, tag)}.</p>`;
const run = async (files: Record<string, string>) => assessSafety(await crawlSite(ORIGIN, fake(files), { maxPages: 50 }));

describe('site safety', () => {
  it('scores a healthy site as safe with nothing to fix', async () => {
    const r = await run({ '/': html('Home', good('h') + nav), '/a': html('A', good('a')), '/b': html('B', good('b')), '/c': html('C', good('c')), '/d': html('D', good('d')), '/e': html('E', good('e')) });
    expect(r.findings).toEqual([]);
    expect(r.score).toBe(100);
    expect(r.band).toBe('safe');
  });

  it('flags thin pages, and only recommends removal when nothing links to them', async () => {
    const r = await run({ '/': html('Home', good('h') + '<a href="/linked">l</a>'), '/linked': html('Linked', '<p>Tiny page about us.</p>'), '/orphan': html('Orphan', '<p>Tiny.</p>') });
    // orphan is not crawled (nothing links to it), so only the linked one is seen
    expect(r.verdicts.find((v) => v.url === `${ORIGIN}/linked`)?.action).toBe('expand');
  });

  it('marks an unlinked thin page for removal', async () => {
    const snap = await crawlSite(ORIGIN, fake({ '/': html('Home', good('h') + '<a href="/t">t</a>'), '/t': html('T', '<p>Tiny.</p>') }), { maxPages: 10 });
    snap.inbound.set(`${ORIGIN}/t`, new Set());
    expect(assessSafety(snap).verdicts.find((v) => v.url === `${ORIGIN}/t`)?.action).toBe('prune');
  });

  it('never recommends removing the home page', async () => {
    const r = await run({ '/': html('Home', '<p>Tiny.</p>') });
    expect(r.verdicts[0]?.action).toBe('expand');
  });

  it('finds a templated town set and keeps the best-linked page', async () => {
    const town = (t: string) => html(`Plumber in ${t}`, `<p>${unique(150, 'same')} ${t}.</p>`);
    const r = await run({
      '/': html('Home', good('h') + '<a href="/leeds">1</a><a href="/york">2</a><a href="/hull">3</a>'),
      '/leeds': town('Leeds'), '/york': town('York'), '/hull': town('Hull'),
    });
    const set = r.findings.filter((f) => f.id === 'templated-set');
    expect(set).toHaveLength(2);
    expect(set.every((f) => f.severity === 'high' && f.keepUrl)).toBe(true);
    expect(r.verdicts.filter((v) => v.action === 'merge')).toHaveLength(2);
    expect(r.score).toBeLessThan(100);
  });

  it('treats two near-copies as a pair, not a templated set', async () => {
    const r = await run({ '/': html('Home', good('h') + '<a href="/x">x</a><a href="/y">y</a>'), '/x': html('X', `<p>${unique(200, 'dup')}</p>`), '/y': html('Y', `<p>${unique(200, 'dup')}</p>`) });
    expect(r.findings.map((f) => f.id)).toEqual(['near-copy']);
  });

  it('does not call genuinely different pages copies', async () => {
    const r = await run({ '/': html('Home', good('h') + '<a href="/x">x</a><a href="/y">y</a>'), '/x': html('X', good('xx')), '/y': html('Y', good('yy')) });
    expect(r.findings.filter((f) => f.id.includes('copy') || f.id.includes('set'))).toEqual([]);
  });

  it('flags padded repeats, stuffing and stock AI wording', async () => {
    const line = 'We offer the very best boiler repairs for every customer. ';
    const filler = "In today's fast-paced world it is important to note that we delve into quality. Look no further. ";
    const stuffed = 'boiler '.repeat(60) + unique(100, 'z');
    const r = await run({
      '/': html('Home', good('h') + '<a href="/p">p</a><a href="/f">f</a><a href="/s">s</a>'),
      '/p': html('P', `<p>${line.repeat(12)}${unique(120, 'q')}</p>`),
      '/f': html('F', `<p>${filler}${unique(160, 'f')}</p>`),
      '/s': html('S', `<p>${stuffed}</p>`),
    });
    const ids = r.findings.map((f) => `${f.id}`);
    expect(ids).toContain('repetitive');
    expect(ids).toContain('ai-filler');
    expect(ids).toContain('stuffed');
  });

  it('treats spam outbound links as critical and at risk', async () => {
    const r = await run({ '/': html('Home', good('h') + '<a href="https://bad.test/x">cheap casino bonus</a>') });
    expect(r.findings.some((f) => f.id === 'spam-links' && f.severity === 'critical')).toBe(true);
    expect(r.band).toBe('at risk');
  });

  it('ignores noindex pages', async () => {
    const r = await run({ '/': html('Home', good('h') + '<a href="/n">n</a>'), '/n': html('N', '<p>Tiny.</p>', '<meta name="robots" content="noindex">') });
    expect(r.findings).toEqual([]);
  });

  it('renders a plain report that promises nothing and changes nothing', async () => {
    const r = await run({ '/': html('Home', '<p>Tiny.</p>') });
    const text = renderSafetyReport(r);
    expect(text).toContain('Safety score');
    expect(text).toMatch(/does not predict rankings/);
    expect(text).toMatch(/Nothing on the site has been changed/);
    expect(text).toContain('Expand with real detail');
  });
});
