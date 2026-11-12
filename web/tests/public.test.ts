import { describe, expect, it } from 'vitest';
import { handle } from '../worker/index';
import { LIMITS, tidyHits, visitorHash } from '../worker/publicApi';
import { analysePage, bareHost, detectPlatform, isPublicHostname, parsePublicUrl, platformAdvice, robotsBlocksAll } from '../worker/sitecheck';

const ORIGIN = 'https://inbox.test';
const SERVICE = 'sb_secret_test_service_key';
const NOW = new Date('2026-11-12T12:00:00.000Z');

type Row = Record<string, unknown>;

const GOOD_HOME = `<!doctype html><html lang="en"><head>
<title>Acme Plumbing | Leeds heating and repairs</title>
<meta name="description" content="Family-run plumbers in Leeds. Boiler repairs, bathrooms and emergency call-outs, with fixed prices agreed before we start work.">
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><h1>Plumbers you can trust</h1><a href="/blog/">Our blog</a>
<img src="a.jpg" alt="A boiler"><img src="b.jpg" alt="">
<p>${'We fix boilers and bathrooms across Leeds. '.repeat(40)}</p></body></html>`;

/** A pretend Supabase (only the two public tables) and a pretend internet of websites. */
class World {
  hits: Row[] = [];
  signups: Row[] = [];
  tableMissing = false;
  sites = new Map<string, { status?: number; type?: string; body?: string; location?: string }>();
  requests: { host: string; path: string; method: string }[] = [];
  now = NOW;

  site(host: string, path: string, page: { status?: number; type?: string; body?: string; location?: string }) {
    this.sites.set(`${host}${path}`, page);
    return this;
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init.method ?? 'GET';
    this.requests.push({ host: url.host, path: url.pathname, method });
    if (url.host === 'proj.supabase.co') return this.supabase(url, method, typeof init.body === 'string' ? init.body : undefined);
    const page = this.sites.get(`${url.host}${url.pathname}`);
    if (!page) throw new Error(`could not connect to ${url.host}`);
    if (page.location) return new Response(null, { status: page.status ?? 302, headers: { Location: page.location } });
    return new Response(page.body ?? '', { status: page.status ?? 200, headers: { 'Content-Type': page.type ?? 'text/html; charset=utf-8' } });
  };

  siteRequests() {
    return this.requests.filter((r) => r.host !== 'proj.supabase.co');
  }

  private supabase(url: URL, method: string, body: string | undefined): Response {
    const table = /^\/rest\/v1\/(\w+)$/.exec(url.pathname)?.[1];
    const rows = table === 'public_hits' ? this.hits : table === 'signup_requests' ? this.signups : undefined;
    if (!rows || this.tableMissing) return new Response(JSON.stringify({ message: 'relation does not exist' }), { status: 404 });
    const match = (row: Row) =>
      [...url.searchParams].every(([k, v]) => {
        if (['select', 'limit', 'order'].includes(k)) return true;
        const [op, ...rest] = v.split('.');
        const val = rest.join('.');
        if (op === 'eq') return String(row[k]) === val;
        if (op === 'gt') return String(row[k]) > val;
        if (op === 'lt') return String(row[k]) < val;
        throw new Error(`fake does not know filter ${v}`);
      });
    if (method === 'GET') {
      const out = rows.filter(match);
      const limit = Number(url.searchParams.get('limit') ?? 0);
      return new Response(JSON.stringify(limit ? out.slice(0, limit) : out), { status: 200 });
    }
    if (method === 'POST') {
      const row = JSON.parse(body ?? '{}') as Row;
      if (table === 'signup_requests' && rows.some((r) => r.email === row.email && r.host === row.host && r.status === 'pending')) return new Response('{}', { status: 409 }); // the real database refuses a second pending one
      rows.push({ created_at: this.now.toISOString(), ...row });
      return new Response(null, { status: 201 });
    }
    if (method === 'DELETE') {
      const keep = rows.filter((r) => !match(r));
      rows.length = 0;
      rows.push(...keep);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }
}

const env = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_KEY: SERVICE, ASSETS: { fetch: async () => new Response('page') } };

async function call(w: World, path: string, body: unknown, opts: { ip?: string; origin?: string; raw?: string; type?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': opts.type ?? 'application/json', 'CF-Connecting-IP': opts.ip ?? '203.0.113.7' };
  if (opts.origin) headers.Origin = opts.origin;
  const res = await handle(new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body: opts.raw ?? JSON.stringify(body) }), env, { fetch: w.fetch, now: () => w.now });
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

const check = (w: World, url: unknown, opts = {}) => call(w, '/api/site-check', { url }, opts);
const join = (w: World, body: Record<string, unknown>, opts = {}) => call(w, '/api/signup', body, opts);
const goodSite = () => new World().site('acme-plumbing.co.uk', '/', { body: GOOD_HOME }).site('acme-plumbing.co.uk', '/robots.txt', { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' });

// ---------------------------------------------------------------------------------------------

describe('which addresses count as a public website', () => {
  it('accepts ordinary addresses, with or without https and www, and tidies them', () => {
    expect(parsePublicUrl('acme-plumbing.co.uk')?.href).toBe('https://acme-plumbing.co.uk/');
    expect(parsePublicUrl('  https://www.Acme.com/about?x=1#top ')?.href).toBe('https://www.acme.com/about?x=1');
    expect(parsePublicUrl('http://shop.acme.com:80/')?.hostname).toBe('shop.acme.com');
    expect(parsePublicUrl('bücher.example.de')?.hostname).toBe('xn--bcher-kva.example.de');
    expect(bareHost(parsePublicUrl('https://WWW.Acme.com.')!)).toBe('acme.com');
  });

  it('refuses everything that points inward, in every spelling', () => {
    for (const bad of [
      'localhost', 'http://localhost/', 'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::1]/', 'http://10.0.0.5/', 'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/', 'printer.local', 'db.internal', 'nas.lan', 'thing.localhost', 'intranet', 'a.test', 'x.invalid', 'secret.onion', 'home.arpa',
    ]) {
      expect(parsePublicUrl(bad), bad).toBeUndefined();
    }
  });

  it('refuses things that are not plain web addresses', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://acme.com', 'data:text/html,hi', 'https://user:pw@acme.com', 'https://acme.com:8080', 'acme .com', '<script>', '', '   ', 'x'.repeat(400) + '.com'])
      expect(parsePublicUrl(bad), bad).toBeUndefined();
    for (const notText of [undefined, null, 5, {}, ['acme.com']]) expect(parsePublicUrl(notText)).toBeUndefined();
  });

  it('checks host names on their own too', () => {
    expect(isPublicHostname('acme.co.uk')).toBe(true);
    expect(isPublicHostname('-bad.com')).toBe(false);
    expect(isPublicHostname('a..b.com')).toBe(false);
  });
});

describe('reading robots.txt', () => {
  it('spots a site that shuts every crawler out, and only that', () => {
    expect(robotsBlocksAll('User-agent: *\nDisallow: /')).toBe(true);
    expect(robotsBlocksAll('User-agent: *\r\nDisallow: /  # everyone out\r\n')).toBe(true);
    expect(robotsBlocksAll('User-agent: *\nDisallow: /private/')).toBe(false);
    expect(robotsBlocksAll('User-agent: *\nDisallow:')).toBe(false);
    expect(robotsBlocksAll('User-agent: BadBot\nDisallow: /')).toBe(false);
    expect(robotsBlocksAll('User-agent: BadBot\nUser-agent: *\nDisallow: /')).toBe(true);
    expect(robotsBlocksAll('User-agent: *\nDisallow: /\nAllow: /')).toBe(false);
    expect(robotsBlocksAll('User-agent: Googlebot\nDisallow: /nothing\nUser-agent: *\nDisallow: /')).toBe(true);
    expect(robotsBlocksAll('')).toBe(false);
  });
});

describe('guessing what a site is built with', () => {
  it('recognises the common platforms and admits when it cannot tell', () => {
    expect(detectPlatform('<link href="/wp-content/themes/x.css">')).toBe('wordpress');
    expect(detectPlatform('<script src="https://cdn.shopify.com/s/x.js">')).toBe('shopify');
    expect(detectPlatform('<meta name="generator" content="Astro v4">')).toBe('astro');
    expect(detectPlatform('<div id="__next_data__">')).toBe('nextjs');
    expect(detectPlatform('<html><body>hello</body></html>')).toBe('unknown');
  });

  it('only says "now" for kinds of site we can really connect today, and promises nothing for the rest', () => {
    expect(platformAdvice('astro').availability).toBe('now');
    expect(platformAdvice('wordpress').availability).toBe('soon');
    expect(platformAdvice('wix').availability).toBe('later');
    expect(platformAdvice('unknown').availability).toBe('ask');
    for (const p of ['wordpress', 'shopify', 'wix', 'squarespace', 'webflow', 'unknown'] as const) expect(platformAdvice(p).availability).not.toBe('now');
    for (const p of ['astro', 'wordpress', 'wix', 'squarespace', 'unknown'] as const) expect(platformAdvice(p).text.toLowerCase()).not.toMatch(/rank|#1|first page|guarantee/);
  });
});

describe('what the page check says', () => {
  const url = new URL('https://acme-plumbing.co.uk/');
  const level = (html: string, id: string, robots?: string) => analysePage(html, url, robots).findings.find((f) => f.id === id)?.level;

  it('has no problems to fix on a well-made home page', () => {
    const a = analysePage(GOOD_HOME, url, 'User-agent: *\nAllow: /');
    expect(a.findings.filter((f) => f.level === 'fix')).toEqual([]);
    expect(a.findings.find((f) => f.id === 'blog')?.level).toBe('good');
    expect(a.facts.title).toContain('Acme Plumbing');
  });

  it('flags each real problem on a poor page', () => {
    const bad = analysePage('<html><head><meta name="robots" content="NOINDEX, nofollow"></head><body><img src="x.jpg"><img src="y.jpg" alt="ok">hi</body></html>', new URL('http://acme.com/'), 'User-agent: *\nDisallow: /');
    const fixes = bad.findings.filter((f) => f.level === 'fix').map((f) => f.id);
    expect(fixes).toEqual(expect.arrayContaining(['noindex', 'robots', 'https', 'title', 'description', 'h1', 'mobile', 'alt']));
    expect(bad.findings.find((f) => f.id === 'alt')?.title).toBe('1 of 2 images have no description');
    expect(bad.findings.find((f) => f.id === 'blog')?.level).toBe('info');
  });

  it('counts an empty image description as fine (decorative) but a missing one as a problem', () => {
    expect(level('<img src="a" alt="">', 'alt')).toBe('good');
    expect(level('<img src="a">', 'alt')).toBe('fix');
  });

  it('only counts a blog link that stays on the same site', () => {
    expect(level('<a href="https://other.com/blog/">x</a>', 'blog')).toBe('info');
    expect(level('<a href="https://acme-plumbing.co.uk/news/post">x</a>', 'blog')).toBe('good');
    expect(level('<a href="/blogger-profile">x</a>', 'blog')).toBe('info');
  });

  it('tells a very short page from a full one', () => {
    expect(level('<body>hello</body>', 'words')).toBe('info');
    expect(level(GOOD_HOME, 'words')).toBeUndefined();
  });

  it('never makes a ranking promise in anything it says', () => {
    const everything = JSON.stringify(analysePage('<html></html>', new URL('http://x.com/'), 'User-agent: *\nDisallow: /').findings).toLowerCase();
    expect(everything).not.toMatch(/guarantee|#1|top of google|first page of google/);
  });

  it('survives hostile page content (long runs, odd tags) quickly and leaves text for the screen to escape', () => {
    const t0 = Date.now();
    const nasty = `<title>${'<'.repeat(50_000)}</title><img ${'a'.repeat(100_000)}><a ${'href='.repeat(20_000)}>${'<script>'.repeat(10_000)}`;
    analysePage(nasty, url);
    expect(Date.now() - t0).toBeLessThan(2000);
    const a = analysePage('<title><img src=x onerror=alert(1)></title>', url);
    expect(a.facts.title.length).toBeLessThanOrEqual(120);
  });
});

describe('POST /api/site-check', () => {
  it('reads a public home page and reports in plain English, with no AI and no other network calls', async () => {
    const w = goodSite();
    const r = await check(w, 'Acme-Plumbing.co.uk');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, site: 'acme-plumbing.co.uk', platform: 'unknown', availability: 'ask' });
    expect(r.json.summary.fix).toBe(0);
    expect(r.json.note).toMatch(/promises nothing/);
    expect(w.siteRequests().map((x) => `${x.host}${x.path}`)).toEqual(['acme-plumbing.co.uk/', 'acme-plumbing.co.uk/robots.txt']);
    expect(w.requests.every((x) => x.method === 'GET' || x.host === 'proj.supabase.co')).toBe(true);
  });

  it('says when robots.txt shuts everyone out', async () => {
    const w = goodSite().site('acme-plumbing.co.uk', '/robots.txt', { type: 'text/plain', body: 'User-agent: *\nDisallow: /' });
    const r = await check(w, 'acme-plumbing.co.uk');
    expect(r.json.findings.find((f: any) => f.id === 'robots')?.level).toBe('fix');
  });

  it('still works when the site has no robots.txt', async () => {
    const w = new World().site('acme-plumbing.co.uk', '/', { body: GOOD_HOME });
    w.fetch = ((orig) => async (i: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(typeof i === 'string' ? i : i instanceof URL ? i.href : i.url);
      if (u.pathname === '/robots.txt') return new Response('nope', { status: 404 });
      return orig(i, init);
    })(w.fetch);
    const r = await check(w, 'acme-plumbing.co.uk');
    expect(r.status).toBe(200);
    expect(r.json.findings.some((f: any) => f.id === 'robots')).toBe(false);
  });

  it('refuses private and odd addresses before touching any network at all', async () => {
    const w = goodSite();
    for (const bad of ['localhost', '127.0.0.1', 'http://169.254.169.254/', 'file:///etc/passwd', 'intranet', 5, undefined]) {
      const r = await check(w, bad);
      expect(r.status, String(bad)).toBe(400);
      expect(r.json.code).toBe('bad_url');
    }
    expect(w.requests).toEqual([]);
  });

  it('follows ordinary redirects but never into a private address', async () => {
    const w = goodSite().site('old.acme-plumbing.co.uk', '/', { location: 'https://acme-plumbing.co.uk/' });
    expect((await check(w, 'old.acme-plumbing.co.uk')).status).toBe(200);
    for (const target of ['http://127.0.0.1/admin', 'http://169.254.169.254/latest/meta-data/', 'https://intranet/', 'file:///etc/passwd', 'http://[::1]/']) {
      const evil = goodSite().site('evil.example.org', '/', { location: target });
      const r = await check(evil, 'evil.example.org', { ip: '198.51.100.9' });
      expect(r.status, target).toBe(422);
      expect(evil.siteRequests().map((x) => x.host), target).toEqual(['evil.example.org']);
    }
  });

  it('gives up on a redirect loop', async () => {
    const w = new World().site('a.acme.co.uk', '/', { location: 'https://a.acme.co.uk/' });
    const r = await check(w, 'a.acme.co.uk');
    expect(r.status).toBe(422);
    expect(r.json.code).toBe('too_many_redirects');
    expect(w.siteRequests().length).toBe(5);
  });

  it('is kind about sites that block robots, are down, or are not web pages', async () => {
    const w = new World()
      .site('walled.co.uk', '/', { status: 403, body: 'no' })
      .site('files.co.uk', '/', { type: 'application/pdf', body: '%PDF' })
      .site('broken.co.uk', '/', { status: 500 });
    expect((await check(w, 'walled.co.uk')).json.code).toBe('blocked');
    expect((await check(w, 'files.co.uk')).json.code).toBe('not_a_page');
    expect((await check(w, 'broken.co.uk')).json.code).toBe('unreachable');
    expect((await check(w, 'nowhere.co.uk')).json.code).toBe('unreachable');
  });

  it('stops reading a huge page after a fixed amount, instead of pulling all of it', async () => {
    const w = new World();
    let pulled = 0;
    const real = w.fetch;
    w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (u.host !== 'big.co.uk' || u.pathname !== '/') return real(input, init);
      const chunk = new TextEncoder().encode('x'.repeat(100_000));
      const head = new TextEncoder().encode('<title>Big</title>');
      let n = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (n >= 200) return c.close(); // 20 MB on offer
          pulled++;
          c.enqueue(n++ === 0 ? head : chunk);
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });
    };
    const r = await check(w, 'big.co.uk');
    expect(r.status).toBe(200);
    expect(r.json.title).toBe('Big');
    expect(pulled).toBeLessThanOrEqual(8); // about 400 KB, not 20 MB
  });

  it('only accepts a JSON body of sensible size, from our own page', async () => {
    const w = goodSite();
    expect((await check(w, 'acme-plumbing.co.uk', { type: 'text/plain' })).status).toBe(400);
    expect((await check(w, 'acme-plumbing.co.uk', { raw: 'not json' })).status).toBe(400);
    expect((await check(w, 'acme-plumbing.co.uk', { raw: JSON.stringify({ url: 'a'.repeat(9000) }) })).status).toBe(400);
    expect((await check(w, 'acme-plumbing.co.uk', { raw: '[]' })).status).toBe(400);
    expect((await check(w, 'acme-plumbing.co.uk', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await check(w, 'acme-plumbing.co.uk', { origin: ORIGIN })).status).toBe(200);
    expect(w.siteRequests().length).toBe(2); // only the one good call went out
  });

  it('limits each visitor per hour, counting failed checks too, and lets a different visitor in', async () => {
    const w = goodSite();
    for (let i = 0; i < LIMITS.siteCheck.perVisitor; i++) expect((await check(w, i % 2 ? 'acme-plumbing.co.uk' : 'nowhere.co.uk')).status).not.toBe(429);
    const before = w.siteRequests().length;
    const blocked = await check(w, 'acme-plumbing.co.uk');
    expect(blocked.status).toBe(429);
    expect(blocked.json.code).toBe('rate_limited');
    expect(w.siteRequests().length).toBe(before); // the refused call never fetched the site
    expect((await check(w, 'acme-plumbing.co.uk', { ip: '198.51.100.20' })).status).toBe(200);
    w.now = new Date(NOW.getTime() + 61 * 60_000); // an hour later the same visitor is fine again
    expect((await check(w, 'acme-plumbing.co.uk')).status).toBe(200);
  });

  it('has an overall hourly brake as well, whoever is asking', async () => {
    const w = goodSite();
    for (let i = 0; i < LIMITS.siteCheck.overall; i++) w.hits.push({ kind: 'site_check', ip_hash: `other-${i}`, created_at: NOW.toISOString() });
    const r = await check(w, 'acme-plumbing.co.uk', { ip: '198.51.100.77' });
    expect(r.status).toBe(429);
    expect(w.siteRequests()).toEqual([]);
  });

  it('refuses to work, rather than work unlimited, when the counting table is missing', async () => {
    const w = goodSite();
    w.tableMissing = true;
    const r = await check(w, 'acme-plumbing.co.uk');
    expect(r.status).toBe(503);
    expect(r.json.code).toBe('not_configured');
    expect(w.siteRequests()).toEqual([]);
  });

  it('stores only a salted hash of the visitor, and never leaks the server key', async () => {
    const w = goodSite();
    const r = await check(w, 'acme-plumbing.co.uk', { ip: '203.0.113.7' });
    expect(w.hits).toHaveLength(1);
    expect(w.hits[0]!.ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(w.hits)).not.toContain('203.0.113.7');
    expect(r.text).not.toContain(SERVICE);
    expect(r.text).not.toContain('203.0.113.7');
    expect(await visitorHash(SERVICE, '203.0.113.7')).toBe(w.hits[0]!.ip_hash);
    expect(await visitorHash('another-key', '203.0.113.7')).not.toBe(w.hits[0]!.ip_hash);
  });

  it('is POST only', async () => {
    const res = await handle(new Request(`${ORIGIN}/api/site-check`), env, { fetch: new World().fetch });
    expect(res.status).toBe(405);
  });
});

describe('POST /api/signup', () => {
  const body = { email: 'Owner@Acme-Plumbing.co.uk ', url: 'https://www.acme-plumbing.co.uk/about', consent: true };

  it('records a waiting request and starts nothing', async () => {
    const w = goodSite();
    const r = await join(w, body);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(w.signups).toHaveLength(1);
    expect(w.signups[0]).toMatchObject({ email: 'owner@acme-plumbing.co.uk', site_url: 'https://www.acme-plumbing.co.uk', host: 'acme-plumbing.co.uk', status: 'pending', consent_version: 'v1' });
    expect(w.signups[0]!.consent_at).toBe(NOW.toISOString());
    expect(JSON.stringify(w.signups)).not.toContain('203.0.113.7');
    // it never looked at their site, never wrote any other table, and sent nothing anywhere
    expect(w.siteRequests()).toEqual([]);
    expect(w.requests.every((x) => x.host === 'proj.supabase.co' && /public_hits|signup_requests/.test(x.path))).toBe(true);
  });

  it('will not record anyone who has not ticked the box', async () => {
    const w = goodSite();
    for (const consent of [false, undefined, 'true', 1, null]) {
      const r = await join(w, { ...body, consent });
      expect(r.status).toBe(400);
      expect(r.json.code).toBe('consent_needed');
    }
    expect(w.signups).toEqual([]);
  });

  it('turns away bad emails and bad addresses', async () => {
    const w = goodSite();
    for (const email of ['', 'nope', 'a@b', 'two words@x.com', '<x>@y.com', 'a@b.c', `${'a'.repeat(250)}@x.com`, 5, undefined]) {
      expect((await join(w, { ...body, email }, { ip: `192.0.2.${Math.floor(Math.random() * 250)}` })).json.code, String(email)).toBe('bad_email');
    }
    for (const url of ['localhost', 'javascript:x', undefined]) expect((await join(w, { ...body, url }, { ip: '192.0.2.99' })).json.code).toBe('bad_url');
    expect(w.signups).toEqual([]);
  });

  it('looks happy to a bot that fills the hidden field, and stores nothing', async () => {
    const w = goodSite();
    const r = await join(w, { ...body, company: 'Spam Ltd' });
    expect(r).toMatchObject({ status: 200, json: { ok: true } });
    expect(w.signups).toEqual([]);
    expect(w.requests).toEqual([]);
  });

  it('answers a repeat the same way and keeps one waiting request, so it cannot reveal who signed up', async () => {
    const w = goodSite();
    const first = await join(w, body);
    const again = await join(w, { ...body, email: 'OWNER@acme-plumbing.co.uk', url: 'acme-plumbing.co.uk' });
    expect(again.text).toBe(first.text);
    expect(w.signups).toHaveLength(1);
    await join(w, { ...body, url: 'other-site.co.uk' });
    expect(w.signups).toHaveLength(2);
  });

  it('limits sign-ups per visitor per hour', async () => {
    const w = goodSite();
    for (let i = 0; i < LIMITS.signup.perVisitor; i++) expect((await join(w, { ...body, email: `p${i}@acme.co.uk` })).status).toBe(200);
    expect((await join(w, { ...body, email: 'late@acme.co.uk' })).status).toBe(429);
    expect(w.signups).toHaveLength(LIMITS.signup.perVisitor);
  });

  it('refuses to work when the tables are missing, and from other websites', async () => {
    const w = goodSite();
    expect((await join(w, body, { origin: 'https://evil.example' })).status).toBe(403);
    w.tableMissing = true;
    expect((await join(w, body)).json.code).toBe('not_configured');
    expect(w.signups).toEqual([]);
  });

  it('tidies away counting rows older than a day and nothing newer', async () => {
    const w = goodSite();
    w.hits.push({ kind: 'signup', ip_hash: 'old', created_at: new Date(NOW.getTime() - 25 * 3_600_000).toISOString() }, { kind: 'signup', ip_hash: 'new', created_at: new Date(NOW.getTime() - 3_600_000).toISOString() });
    const { Db } = await import('../worker/supabase');
    await tidyHits({ db: new Db('https://proj.supabase.co', SERVICE, w.fetch), now: () => w.now });
    expect(w.hits.map((h) => h.ip_hash)).toEqual(['new']);
  });
});
