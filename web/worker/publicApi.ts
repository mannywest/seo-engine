import { analysePage, bareHost, parsePublicUrl, platformAdvice, PLATFORM_NAMES, type Finding } from './sitecheck';
import { DbError, type Db } from './supabase';
import type { Fetch } from './types';

/**
 * The two PUBLIC addresses behind the front page: the free site check and the sign-up form.
 *
 * Anyone on the internet can call these, so they are built to fail safe:
 *  - the site check only ever reads a public home page (size, time and redirect limits) and never runs AI, so it costs nothing;
 *  - the sign-up form only RECORDS a request. Nothing runs for a stranger until the owner approves them;
 *  - both are limited per visitor and overall, using a table in the database. If that table is missing they refuse to work;
 *  - a visitor's address is stored only as a salted hash, never as itself.
 */

interface PublicCtx {
  db: Db;
  f: Fetch;
  now: () => Date;
  /** Used to salt visitor hashes, so a leaked table does not reveal anyone's address. */
  secret: string;
  origin: string;
}

const HOUR = 3_600_000;
export const LIMITS = {
  siteCheck: { perVisitor: 10, overall: 400 },
  signup: { perVisitor: 5, overall: 200 },
};
const MAX_BODY = 4_000;
const MAX_PAGE_BYTES = 400_000;
const MAX_ROBOTS_BYTES = 60_000;
const MAX_REDIRECTS = 4;
const FETCH_MS = 8_000;
export const CONSENT_VERSION = 'v1';

const noStore = { 'Cache-Control': 'no-store' };
const enc = encodeURIComponent;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...noStore } });
}

const refuse = (status: number, error: string, code: string) => json(status, { error, code });

// ---- shared guards ----------------------------------------------------------------------------

/** A browser on another website must not use our checker as a free tool. Calls with no Origin (curl, the page itself on some browsers) are left to the limits. */
function sameOrigin(req: Request, origin: string): boolean {
  const o = req.headers.get('Origin');
  return !o || o === origin;
}

async function readJson(req: Request): Promise<Record<string, unknown> | undefined> {
  if (!(req.headers.get('Content-Type') ?? '').toLowerCase().includes('application/json')) return undefined;
  const text = await req.text();
  if (text.length > MAX_BODY) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A salted hash of the visitor's network address: enough to count visits, useless for finding anyone. */
export async function visitorHash(secret: string, ip: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`lodestar-visitor-v1:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip)));
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type Kind = 'site_check' | 'signup';

/** True when this visitor and the site as a whole are under their hourly limits. Counts rows, so a missing table throws DbError. */
async function underLimit(ctx: PublicCtx, kind: Kind, hash: string, limit: { perVisitor: number; overall: number }): Promise<boolean> {
  const since = enc(new Date(ctx.now().getTime() - HOUR).toISOString());
  const mine = await ctx.db.select<{ id: number }>('public_hits', `kind=eq.${kind}&ip_hash=eq.${enc(hash)}&created_at=gt.${since}&select=id&limit=${limit.perVisitor}`);
  if (mine.length >= limit.perVisitor) return false;
  const all = await ctx.db.select<{ id: number }>('public_hits', `kind=eq.${kind}&created_at=gt.${since}&select=id&limit=${limit.overall}`);
  return all.length < limit.overall;
}

const recordHit = (ctx: PublicCtx, kind: Kind, hash: string) => ctx.db.insert('public_hits', { kind, ip_hash: hash, created_at: ctx.now().toISOString() });

/** Old counting rows are no use after a day. Called now and then from the sign-up path. */
export async function tidyHits(ctx: Pick<PublicCtx, 'db' | 'now'>): Promise<void> {
  await ctx.db.remove('public_hits', `created_at=lt.${enc(new Date(ctx.now().getTime() - 24 * HOUR).toISOString())}`);
}

const notSwitchedOn = () => refuse(503, 'This is not switched on yet. Please try again soon.', 'not_configured');

// ---- fetching a page safely ---------------------------------------------------------------------

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, max);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(Math.min(size, max));
  let at = 0;
  for (const c of chunks) {
    const take = c.subarray(0, Math.max(0, all.length - at));
    all.set(take, at);
    at += take.length;
    if (at >= all.length) break;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(all);
}

type Fetched = { ok: true; url: URL; status: number; type: string; text: string } | { ok: false; reason: 'unreachable' | 'blocked' | 'not_a_page' | 'too_many_redirects'; status?: number };

/** One careful GET: redirects are followed by hand so every hop is checked as a public address again. */
async function fetchPublic(f: Fetch, start: URL, accept: string, maxBytes: number): Promise<Fetched> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await f(url.href, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LodestarSiteCheck/1.0)', Accept: accept },
        signal: AbortSignal.timeout(FETCH_MS),
      });
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('Location');
      await res.body?.cancel().catch(() => undefined);
      let next: URL | undefined;
      try {
        next = loc ? parsePublicUrl(new URL(loc, url).href) : undefined;
      } catch {
        next = undefined;
      }
      if (!next) return { ok: false, reason: 'unreachable' }; // redirected somewhere that is not a public website
      url = next;
      continue;
    }
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status === 503) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, reason: 'blocked', status: res.status };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, reason: 'unreachable', status: res.status };
    }
    const type = (res.headers.get('Content-Type') ?? '').toLowerCase();
    let text: string;
    try {
      text = await readCapped(res, maxBytes);
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
    return { ok: true, url, status: res.status, type, text };
  }
  return { ok: false, reason: 'too_many_redirects' };
}

const REASON_TEXT: Record<'unreachable' | 'blocked' | 'not_a_page' | 'too_many_redirects', string> = {
  unreachable: 'We could not reach that address. Please check the spelling, or try again in a minute.',
  blocked: 'That site would not let our checker in. It may block automated visitors. You can still sign up and we will look at it properly.',
  not_a_page: 'That address did not give us a web page to look at.',
  too_many_redirects: 'That address sent us round in circles. Try the exact address from your browser.',
};

// ---- POST /api/site-check ------------------------------------------------------------------------

export interface SiteCheckResult {
  ok: true;
  site: string;
  platform: string;
  platformName: string;
  availability: string;
  advice: string;
  title: string;
  findings: Finding[];
  summary: { good: number; fix: number; info: number };
  note: string;
}

export async function siteCheck(req: Request, ctx: PublicCtx): Promise<Response> {
  if (!sameOrigin(req, ctx.origin)) return refuse(403, 'That request did not come from our own page.', 'forbidden');
  const body = await readJson(req);
  if (!body) return refuse(400, 'Please send a website address.', 'bad_request');
  const url = parsePublicUrl(body.url);
  if (!url) return refuse(400, 'That does not look like a website address. Try something like acme-plumbing.co.uk.', 'bad_url');

  const hash = await visitorHash(ctx.secret, req.headers.get('CF-Connecting-IP') ?? 'unknown');
  try {
    if (!(await underLimit(ctx, 'site_check', hash, LIMITS.siteCheck))) return refuse(429, 'That is a lot of checks. Please try again in an hour.', 'rate_limited');
    await recordHit(ctx, 'site_check', hash); // counted before the fetch, so failures count too
  } catch (e) {
    if (e instanceof DbError && e.status === 404) return notSwitchedOn();
    throw e;
  }

  const page = await fetchPublic(ctx.f, url, 'text/html,application/xhtml+xml', MAX_PAGE_BYTES);
  if (!page.ok) return refuse(422, REASON_TEXT[page.reason], page.reason);
  if (!page.type.includes('html')) return refuse(422, REASON_TEXT.not_a_page, 'not_a_page');

  // robots.txt on the same site (a failure here just means we say nothing about it)
  let robots: string | undefined;
  const robotsUrl = parsePublicUrl(new URL('/robots.txt', page.url).href);
  if (robotsUrl && bareHost(robotsUrl) === bareHost(page.url)) {
    const r = await fetchPublic(ctx.f, robotsUrl, 'text/plain', MAX_ROBOTS_BYTES);
    if (r.ok && !r.type.includes('html')) robots = r.text;
  }

  const { facts, findings } = analysePage(page.text, page.url, robots);
  const advice = platformAdvice(facts.platform);
  const summary = { good: 0, fix: 0, info: 0 };
  for (const f of findings) summary[f.level]++;
  const result: SiteCheckResult = {
    ok: true,
    site: bareHost(page.url),
    platform: facts.platform,
    platformName: PLATFORM_NAMES[facts.platform],
    availability: advice.availability,
    advice: advice.text,
    title: facts.title,
    findings,
    summary,
    note: 'This is a quick look at your home page only. It is not a ranking and promises nothing about where you will appear in Google.',
  };
  return json(200, result);
}

// ---- POST /api/signup ----------------------------------------------------------------------------

const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/;

/**
 * Records a request to join. It never starts any work and always answers the same way for a repeat, so the form cannot be
 * used to find out who has signed up. A hidden field real visitors never see (`company`) catches simple bots.
 */
export async function signup(req: Request, ctx: PublicCtx): Promise<Response> {
  if (!sameOrigin(req, ctx.origin)) return refuse(403, 'That request did not come from our own page.', 'forbidden');
  const body = await readJson(req);
  if (!body) return refuse(400, 'Please fill in the form again.', 'bad_request');

  if (typeof body.company === 'string' && body.company.trim()) return json(200, { ok: true }); // a bot filled the hidden field: look happy, store nothing

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL.test(email)) return refuse(400, 'That email address does not look right.', 'bad_email');
  const url = parsePublicUrl(body.url);
  if (!url) return refuse(400, 'That does not look like a website address. Try something like acme-plumbing.co.uk.', 'bad_url');
  if (body.consent !== true) return refuse(400, 'Please tick the box so we know you are happy for us to email you about this.', 'consent_needed');

  const hash = await visitorHash(ctx.secret, req.headers.get('CF-Connecting-IP') ?? 'unknown');
  try {
    if (!(await underLimit(ctx, 'signup', hash, LIMITS.signup))) return refuse(429, 'Too many sign-ups from here. Please try again in an hour.', 'rate_limited');
    await recordHit(ctx, 'signup', hash);
    if (Math.random() < 0.05) await tidyHits(ctx).catch(() => undefined);

    const host = bareHost(url);
    const already = await ctx.db.select('signup_requests', `email=eq.${enc(email)}&host=eq.${enc(host)}&status=eq.pending&select=id&limit=1`);
    if (!already.length) {
      await ctx.db.insert('signup_requests', {
        email,
        site_url: url.origin,
        host,
        consent_at: ctx.now().toISOString(),
        consent_version: CONSENT_VERSION,
        status: 'pending',
        ip_hash: hash,
      });
    }
  } catch (e) {
    if (e instanceof DbError && e.status === 404) return notSwitchedOn();
    throw e;
  }
  return json(200, { ok: true });
}
