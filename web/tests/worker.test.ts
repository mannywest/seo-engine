import { describe, expect, it } from 'vitest';
import { buildManifest, cleanContentDir, COOKIE, DEFAULT_CONTENT_DIR } from '../worker/connect';
import { deriveStateKey, randomNonce, signToken, verifyToken } from '../worker/crypto';
import { handle } from '../worker/index';
import { REASONS, reasonText } from '../src/reasons';

const ORIGIN = 'https://inbox.test';
const SERVICE = 'sb_secret_test';
const CLIENT_SECRET = 'sekret-client-secret';
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nTOPSECRETKEY\n-----END RSA PRIVATE KEY-----';

type Row = Record<string, unknown>;
interface Req { host: string; method: string; path: string; headers: Record<string, string>; body?: string }

/** A pretend Supabase and a pretend GitHub, in memory. They enforce the rules the real ones do (a one-time code works once, a user only sees their own installations). */
class World {
  now = new Date('2026-11-11T12:00:00.000Z');
  users: Record<string, { id: string; email: string }> = {
    'jwt-owner': { id: 'u-owner', email: 'owner@acme.test' },
    'jwt-reviewer': { id: 'u-reviewer', email: 'rev@acme.test' },
    'jwt-admin': { id: 'u-admin', email: 'admin@lodestar.test' },
    'jwt-stranger': { id: 'u-stranger', email: 'nobody@x.test' },
  };
  admins: Row[] = [{ user_id: 'u-admin' }];
  members: Row[] = [
    { client_id: 'acme', user_id: 'u-owner', role: 'owner' },
    { client_id: 'acme', user_id: 'u-reviewer', role: 'reviewer' },
  ];
  attempts: Row[] = [];
  connections: Row[] = [];
  vault: Record<string, string> = {};
  putOrder: string[] = [];
  failPut: string | undefined;
  // GitHub
  codes = new Map<string, string>(); // one-time code -> github login
  github: Record<string, { token: string; installs: number[] }> = { octocat: { token: 'ghu_octo', installs: [1001] } };
  installations: Record<number, { account: string; repos: { full_name: string; default_branch: string; archived?: boolean; permissions: { push: boolean; admin?: boolean } }[] }> = {
    1001: {
      account: 'acme-org',
      repos: [
        { full_name: 'acme-org/website', default_branch: 'main', permissions: { push: true } },
        { full_name: 'acme-org/docs', default_branch: 'trunk', permissions: { push: true } },
        { full_name: 'acme-org/readonly', default_branch: 'main', permissions: { push: false } },
        { full_name: 'acme-org/old', default_branch: 'main', archived: true, permissions: { push: true } },
      ],
    },
    2002: { account: 'other-org', repos: [{ full_name: 'other-org/site', default_branch: 'main', permissions: { push: true } }] },
  };
  manifests = new Map<string, unknown>();
  requests: Req[] = [];
  seen: string[] = []; // everything we ever sent back to a browser

  withApp() {
    Object.assign(this.vault, { github_app_id: '777', github_app_slug: 'lodestar-connect', github_app_client_id: 'Iv1.abc', github_app_client_secret: CLIENT_SECRET, github_app_private_key: PEM });
    return this;
  }

  dump() {
    return JSON.stringify({ a: this.attempts, c: this.connections, m: this.members });
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init.headers as HeadersInit).entries());
    const body = typeof init.body === 'string' ? init.body : undefined;
    this.requests.push({ host: url.host, method, path: url.pathname, headers, ...(body ? { body } : {}) });
    if (url.host === 'proj.supabase.co') return this.supabase(url, method, headers, body);
    if (url.host === 'github.com' && url.pathname === '/login/oauth/access_token') return this.exchange(body);
    if (url.host === 'api.github.com') return this.api(url, method, headers);
    throw new Error(`Unexpected network call: ${url.href}`);
  };

  private res(status: number, body?: unknown) {
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }

  private supabase(url: URL, method: string, headers: Record<string, string>, body: string | undefined): Response {
    if (url.pathname === '/auth/v1/user') {
      const u = this.users[(headers.authorization ?? '').replace(/^Bearer /, '')];
      return u ? this.res(200, u) : this.res(401, { message: 'invalid' });
    }
    const rpc = /^\/rest\/v1\/rpc\/(\w+)$/.exec(url.pathname);
    if (rpc) {
      const args = JSON.parse(body ?? '{}') as { p_name: string; p_value?: string };
      if (!args.p_name.startsWith('github_app_')) return this.res(400, { message: 'not allowed' });
      if (rpc[1] === 'lodestar_get_secret') return this.res(200, this.vault[args.p_name] ?? null);
      if (args.p_name === this.failPut) return this.res(500, { message: 'boom' });
      this.vault[args.p_name] = args.p_value!;
      this.putOrder.push(args.p_name);
      return this.res(204);
    }
    const table = /^\/rest\/v1\/(\w+)$/.exec(url.pathname)?.[1];
    const rows = ({ platform_admins: this.admins, client_members: this.members, connect_attempts: this.attempts, site_connections: this.connections } as Record<string, Row[]>)[table ?? ''];
    if (!rows) return this.res(404, { message: 'no such table' });
    const matching = () =>
      rows.filter((row) =>
        [...url.searchParams].every(([k, v]) => {
          if (['select', 'order', 'limit', 'on_conflict'].includes(k)) return true;
          const [op, ...rest] = v.split('.');
          const val = rest.join('.');
          if (op === 'eq') return String(row[k]) === val;
          if (op === 'is') return row[k] === null || row[k] === undefined;
          if (op === 'gt') return row[k] != null && String(row[k]) > val;
          throw new Error(`fake does not know filter ${v}`);
        }),
      );
    if (method === 'GET') {
      let out = matching();
      if (url.searchParams.get('order') === 'created_at.desc') out = [...out].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const limit = Number(url.searchParams.get('limit') ?? 0);
      return this.res(200, limit ? out.slice(0, limit) : out);
    }
    if (method === 'PATCH') {
      const hit = matching();
      for (const r of hit) Object.assign(r, JSON.parse(body!));
      return headers.prefer?.includes('return=representation') ? this.res(200, hit) : this.res(204);
    }
    if (method === 'POST') {
      const row: Row = { created_at: this.now.toISOString(), ...(JSON.parse(body!) as Row) };
      const key = url.searchParams.get('on_conflict');
      const existing = key ? rows.find((r) => r[key] === row[key]) : undefined;
      if (existing) Object.assign(existing, row);
      else rows.push(row);
      return this.res(201);
    }
    return this.res(405);
  }

  private exchange(body: string | undefined): Response {
    const b = JSON.parse(body ?? '{}') as { client_id: string; client_secret: string; code: string };
    const login = this.codes.get(b.code);
    if (b.client_id !== this.vault.github_app_client_id || b.client_secret !== this.vault.github_app_client_secret) return this.res(200, { error: 'incorrect_client_credentials' });
    if (!login) return this.res(200, { error: 'bad_verification_code' });
    this.codes.delete(b.code); // a one-time code works once
    return this.res(200, { access_token: this.github[login]!.token, token_type: 'bearer' });
  }

  private api(url: URL, method: string, headers: Record<string, string>): Response {
    const conv = /^\/app-manifests\/([^/]+)\/conversions$/.exec(url.pathname);
    if (conv) {
      const m = this.manifests.get(decodeURIComponent(conv[1]!));
      if (!m) return this.res(404, { message: 'Not Found' });
      this.manifests.delete(decodeURIComponent(conv[1]!));
      return this.res(201, m);
    }
    const token = (headers.authorization ?? '').replace(/^Bearer /, '');
    const who = Object.values(this.github).find((g) => g.token === token);
    if (!who) return this.res(401, { message: 'Bad credentials' });
    if (url.pathname === '/user/installations') {
      return this.res(200, { total_count: who.installs.length, installations: who.installs.map((id) => ({ id, account: { login: this.installations[id]!.account } })) });
    }
    const repos = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
    if (repos && method === 'GET') {
      const id = Number(repos[1]);
      if (!who.installs.includes(id)) return this.res(404, { message: 'Not Found' });
      return this.res(200, { total_count: this.installations[id]!.repos.length, repositories: this.installations[id]!.repos });
    }
    return this.res(404, { message: 'Not Found' });
  }
}

function setup(w = new World().withApp()) {
  const env = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_KEY: SERVICE, ASSETS: { fetch: async () => new Response('the page') } };
  async function api(path: string, o: { token?: string; body?: unknown; cookie?: string; method?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.cookie) headers.cookie = o.cookie;
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const res = await handle(new Request(ORIGIN + path, { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) }), env, { fetch: w.fetch, now: () => w.now });
    w.seen.push(await res.clone().text(), res.headers.get('location') ?? '', res.headers.get('set-cookie') ?? '');
    return res;
  }
  /** The owner taps Connect: returns what the browser would carry to GitHub and back. */
  async function startConnect(token = 'jwt-owner', clientId = 'acme') {
    const res = await api('/api/connect/github/start', { token, body: { clientId } });
    const { url } = (await res.json()) as { url: string };
    const state = new URL(url).searchParams.get('state')!;
    return { res, url, state, cookie: `${COOKIE}=${new RegExp(`${COOKIE}=([^;]*)`).exec(res.headers.get('set-cookie') ?? '')![1]}` };
  }
  const callback = (params: Record<string, string>, cookie?: string) => api(`/api/connect/github/callback?${new URLSearchParams(params)}`, cookie ? { cookie } : {});
  const loc = (r: Response) => r.headers.get('location') ?? '';
  /** Runs the whole happy path up to "waiting for the person to pick a repo". */
  async function toPick(code = 'code-1') {
    w.codes.set(code, 'octocat');
    const s = await startConnect();
    const back = await callback({ code, state: s.state }, s.cookie);
    return { s, back };
  }
  return { w, api, startConnect, callback, loc, toPick, env };
}

const noSecretsLeaked = (w: World) => {
  const out = w.seen.join('\n');
  expect(out).not.toContain(CLIENT_SECRET);
  expect(out).not.toContain('TOPSECRETKEY');
  expect(out).not.toContain(SERVICE);
  expect(out).not.toContain('ghu_octo');
  expect(w.dump()).not.toContain('ghu_octo');
  expect(w.dump()).not.toContain(CLIENT_SECRET);
};

describe('routing', () => {
  it('serves the page for anything that is not /api/, even with no server settings', async () => {
    const { env } = setup();
    const res = await handle(new Request(`${ORIGIN}/some/page`), { ASSETS: env.ASSETS });
    expect(await res.text()).toBe('the page');
  });
  it('says plainly that connecting is not switched on when the server settings are missing', async () => {
    const { env } = setup();
    const res = await handle(new Request(`${ORIGIN}/api/connect/config`), { ASSETS: env.ASSETS });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'not_configured' });
  });
  it('404s an unknown /api/ address and 405s the wrong method', async () => {
    const { api } = setup();
    expect((await api('/api/nope')).status).toBe(404);
    expect((await api('/api/connect/github/start')).status).toBe(405);
  });
});

describe('signed one-time values', () => {
  it('verifies what it signed, for the right purpose only', async () => {
    const key = await deriveStateKey('k1');
    const n = randomNonce();
    const t = await signToken(key, 'connect', n);
    expect(await verifyToken(key, 'connect', t)).toBe(n);
    expect(await verifyToken(key, 'appsetup', t)).toBeUndefined();
  });
  it('rejects edited, truncated, garbage and wrong-key values', async () => {
    const key = await deriveStateKey('k1');
    const t = await signToken(key, 'connect', randomNonce());
    const [nonce, sig] = t.split('.') as [string, string];
    for (const bad of [`${nonce}x.${sig}`, `${nonce}.${sig.slice(0, -2)}`, `${nonce}.`, `.${sig}`, 'nodot', '', `${nonce}.!!!`, `${randomNonce()}.${sig}`]) {
      expect(await verifyToken(key, 'connect', bad)).toBeUndefined();
    }
    expect(await verifyToken(await deriveStateKey('k2'), 'connect', t)).toBeUndefined();
  });
  it('makes a different nonce every time', () => {
    expect(new Set(Array.from({ length: 50 }, () => randomNonce())).size).toBe(50);
  });
});

describe('who may do what', () => {
  it('wants a real sign-in for every call', async () => {
    const { api } = setup();
    expect((await api('/api/connect/config')).status).toBe(401);
    expect((await api('/api/connect/config', { token: 'forged' })).status).toBe(401);
    expect((await api('/api/connect/github/start', { body: { clientId: 'acme' } })).status).toBe(401);
    expect((await api('/api/admin/github-app/prepare', { method: 'POST', body: {} })).status).toBe(401);
  });
  it('reports whether connecting is ready and whether this person is an administrator', async () => {
    const { api, w } = setup();
    expect(await (await api('/api/connect/config', { token: 'jwt-owner' })).json()).toEqual({ ready: true, admin: false });
    expect(await (await api('/api/connect/config', { token: 'jwt-admin' })).json()).toEqual({ ready: true, admin: true });
    delete w.vault.github_app_id;
    expect(await (await api('/api/connect/config', { token: 'jwt-owner' })).json()).toEqual({ ready: false, admin: false });
  });
  it('lets only an owner of the business start a connection', async () => {
    const { api } = setup();
    expect((await api('/api/connect/github/start', { token: 'jwt-reviewer', body: { clientId: 'acme' } })).status).toBe(403);
    expect((await api('/api/connect/github/start', { token: 'jwt-stranger', body: { clientId: 'acme' } })).status).toBe(403);
    expect((await api('/api/connect/github/start', { token: 'jwt-owner', body: { clientId: 'other' } })).status).toBe(403);
    expect((await api('/api/connect/github/start', { token: 'jwt-owner', body: { clientId: '../x' } })).status).toBe(400);
    expect((await api('/api/connect/github/start', { token: 'jwt-owner', body: {} })).status).toBe(400);
  });
  it('says so plainly when the GitHub App has not been created yet', async () => {
    const { api, w } = setup(new World());
    const res = await api('/api/connect/github/start', { token: 'jwt-owner', body: { clientId: 'acme' } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'app_missing' });
    expect(w.attempts).toHaveLength(0);
  });
});

describe('starting a connection', () => {
  it('sends the owner to GitHub with a signed state, remembers the attempt, and sets a matching cookie', async () => {
    const { startConnect, w } = setup();
    const s = await startConnect();
    const u = new URL(s.url);
    expect(`${u.origin}${u.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('Iv1.abc');
    expect(u.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/connect/github/callback`);
    expect(s.res.headers.get('set-cookie')).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    expect(s.cookie).toBe(`${COOKIE}=${s.state}`);
    expect(w.attempts).toHaveLength(1);
    expect(w.attempts[0]).toMatchObject({ kind: 'github_connect', client_id: 'acme', user_id: 'u-owner', leg: 1 });
    expect(Date.parse(w.attempts[0]!.expires_at as string) - w.now.getTime()).toBe(15 * 60_000);
    expect(s.state.startsWith(w.attempts[0]!.nonce as string)).toBe(true);
    noSecretsLeaked(w);
  });
});

describe('coming back from GitHub (the callback)', () => {
  it('lists only repos the person can write to, drops archived ones, and stores no GitHub key', async () => {
    const { toPick, loc, api, w } = setup();
    const { back } = await toPick();
    expect(back.status).toBe(302);
    expect(loc(back)).toBe('/?connect=pick');
    const pick = w.attempts.find((a) => a.kind === 'github_pick')!;
    expect((pick.candidates as { repo: string }[]).map((c) => c.repo)).toEqual(['acme-org/docs', 'acme-org/website']);
    const p = (await (await api('/api/connect/github/pending?clientId=acme', { token: 'jwt-owner' })).json()) as { pending: { pickId: string; candidates: unknown[]; defaultContentDir: string } };
    expect(p.pending.candidates).toHaveLength(2);
    expect(p.pending.defaultContentDir).toBe(DEFAULT_CONTENT_DIR);
    noSecretsLeaked(w);
  });

  it('never sends the service key to GitHub, or a GitHub key to the database', async () => {
    const { toPick, w } = setup();
    await toPick();
    for (const r of w.requests) {
      if (r.host.endsWith('github.com')) expect(JSON.stringify(r)).not.toContain(SERVICE);
      if (r.host === 'proj.supabase.co') expect(JSON.stringify(r)).not.toContain('ghu_octo');
    }
  });

  it('works when GitHub does not echo the state (the cookie carries it)', async () => {
    const { w, startConnect, callback, loc } = setup();
    w.codes.set('c', 'octocat');
    const s = await startConnect();
    expect(loc(await callback({ code: 'c' }, s.cookie))).toBe('/?connect=pick');
  });

  it('works when the cookie is missing (GitHub opened the link in another browser) because the state carries it', async () => {
    const { w, startConnect, callback, loc } = setup();
    w.codes.set('c', 'octocat');
    const s = await startConnect();
    expect(loc(await callback({ code: 'c', state: s.state }))).toBe('/?connect=pick');
  });

  it('refuses a link that comes back twice (single use) and makes no second pick', async () => {
    const { w, startConnect, callback, loc } = setup();
    w.codes.set('c1', 'octocat');
    w.codes.set('c2', 'octocat');
    const s = await startConnect();
    expect(loc(await callback({ code: 'c1', state: s.state }, s.cookie))).toBe('/?connect=pick');
    expect(loc(await callback({ code: 'c2', state: s.state }, s.cookie))).toBe('/?connect=error&reason=expired');
    expect(w.attempts.filter((a) => a.kind === 'github_pick')).toHaveLength(1);
  });

  it('lets exactly one of two simultaneous returns through', async () => {
    const { w, startConnect, callback, loc } = setup();
    w.codes.set('c1', 'octocat');
    w.codes.set('c2', 'octocat');
    const s = await startConnect();
    const [a, b] = await Promise.all([callback({ code: 'c1', state: s.state }), callback({ code: 'c2', state: s.state })]);
    expect([loc(a), loc(b)].sort()).toEqual(['/?connect=error&reason=expired', '/?connect=pick']);
  });

  it('refuses an expired link', async () => {
    const { w, startConnect, callback, loc } = setup();
    w.codes.set('c', 'octocat');
    const s = await startConnect();
    w.now = new Date(w.now.getTime() + 16 * 60_000);
    expect(loc(await callback({ code: 'c', state: s.state }, s.cookie))).toBe('/?connect=error&reason=expired');
  });

  it('throws away a forged, edited or foreign-purpose state before the database is even asked', async () => {
    const { w, startConnect, callback, loc, api } = setup();
    w.codes.set('c', 'octocat');
    const s = await startConnect();
    const before = w.requests.filter((r) => r.path === '/rest/v1/connect_attempts').length;
    const [nonce, sig] = s.state.split('.') as [string, string];
    for (const bad of [`${nonce}.${sig.slice(0, -3)}AAA`, `${randomNonce()}.${sig}`, 'garbage', `${nonce}.`]) {
      expect(loc(await callback({ code: 'c', state: bad }))).toBe('/?connect=error&reason=invalid');
    }
    // A value genuinely signed by us, but for the app set-up, must not work for connecting a site.
    const setupState = await signToken(await deriveStateKey(SERVICE), 'appsetup', randomNonce());
    expect(loc(await callback({ code: 'c', state: setupState }))).toBe('/?connect=error&reason=invalid');
    expect(w.requests.filter((r) => r.path === '/rest/v1/connect_attempts').length - before).toBe(0);
    expect(w.codes.has('c')).toBe(true); // GitHub was never asked to spend the code
  });

  it('refuses when the state and the cookie disagree, or when neither arrives', async () => {
    const { w, startConnect, callback, loc } = setup();
    w.codes.set('c', 'octocat');
    const a = await startConnect();
    const b = await startConnect();
    expect(loc(await callback({ code: 'c', state: a.state }, b.cookie))).toBe('/?connect=error&reason=invalid');
    expect(loc(await callback({ code: 'c' }))).toBe('/?connect=error&reason=expired');
  });

  it('reports a person saying no on GitHub, and a bad or used-up code', async () => {
    const { w, startConnect, callback, loc } = setup();
    const s = await startConnect();
    expect(loc(await callback({ error: 'access_denied', state: s.state }, s.cookie))).toBe('/?connect=error&reason=denied');
    const s2 = await startConnect();
    expect(loc(await callback({ code: 'never-issued', state: s2.state }, s2.cookie))).toBe('/?connect=error&reason=denied');
    const s3 = await startConnect();
    expect(loc(await callback({ state: s3.state }, s3.cookie))).toBe('/?connect=error&reason=invalid');
    expect(w.attempts.filter((a) => a.kind === 'github_pick')).toHaveLength(0);
  });

  it('does not trust an installation number edited into the address: it must be one GitHub says this person can reach', async () => {
    const { w, startConnect, callback, loc } = setup();
    w.codes.set('c', 'octocat');
    const s = await startConnect();
    expect(loc(await callback({ code: 'c', state: s.state, installation_id: '2002' }, s.cookie))).toBe('/?connect=error&reason=not_yours');
    expect(w.attempts.filter((a) => a.kind === 'github_pick')).toHaveLength(0);
    expect(w.connections).toHaveLength(0);
  });

  it('uses a genuine installation number only to narrow the list', async () => {
    const { w, startConnect, callback, loc } = setup();
    w.github.octocat!.installs = [1001, 2002];
    w.codes.set('c', 'octocat');
    const s = await startConnect();
    expect(loc(await callback({ code: 'c', state: s.state, installation_id: '2002', setup_action: 'install' }, s.cookie))).toBe('/?connect=pick');
    const pick = w.attempts.find((a) => a.kind === 'github_pick')!;
    expect((pick.candidates as { repo: string }[]).map((c) => c.repo)).toEqual(['other-org/site']);
  });

  it('sends a person who has not installed the app yet to install it, once, then back for the pick', async () => {
    const { w, startConnect, callback, loc } = setup();
    w.github.octocat!.installs = [];
    w.codes.set('c1', 'octocat');
    const s = await startConnect();
    const next = loc(await callback({ code: 'c1', state: s.state }, s.cookie));
    const u = new URL(next);
    expect(`${u.origin}${u.pathname}`).toBe('https://github.com/apps/lodestar-connect/installations/new');
    const state2 = u.searchParams.get('state')!;
    expect(w.attempts.find((a) => a.leg === 2)).toBeTruthy();
    // They install it; GitHub sends them back with a fresh code.
    w.github.octocat!.installs = [1001];
    w.codes.set('c2', 'octocat');
    expect(loc(await callback({ code: 'c2', state: state2, installation_id: '1001', setup_action: 'install' }))).toBe('/?connect=pick');
  });

  it('does not loop forever when installing gives no usable repository', async () => {
    const { w, startConnect, callback, loc } = setup();
    w.github.octocat!.installs = [];
    w.codes.set('c1', 'octocat');
    const s = await startConnect();
    const state2 = new URL(loc(await callback({ code: 'c1', state: s.state }, s.cookie))).searchParams.get('state')!;
    w.codes.set('c2', 'octocat');
    expect(loc(await callback({ code: 'c2', state: state2 }))).toBe('/?connect=error&reason=no_repos');
  });

  it('says no_repos when the only repos are read-only or archived', async () => {
    const { w, startConnect, callback, loc } = setup();
    w.installations[1001]!.repos = w.installations[1001]!.repos.filter((r) => r.full_name === 'acme-org/readonly' || r.full_name === 'acme-org/old');
    w.codes.set('c', 'octocat');
    const s = await startConnect();
    expect(loc(await callback({ code: 'c', state: s.state, installation_id: '1001' }, s.cookie))).toBe('/?connect=error&reason=no_repos');
  });
});

describe('choosing the repository and finishing', () => {
  const pickOf = async (t: ReturnType<typeof setup>) => {
    await t.toPick();
    const p = (await (await t.api('/api/connect/github/pending?clientId=acme', { token: 'jwt-owner' })).json()) as { pending: { pickId: string } };
    return p.pending.pickId;
  };
  const choose = { clientId: 'acme', installationId: 1001, repo: 'acme-org/website' };

  it('records the connection: repo, the repo’s own default branch, folder, installation, who did it, and no secret', async () => {
    const t = setup();
    const pickId = await pickOf(t);
    const res = await t.api('/api/connect/github/finish', { token: 'jwt-owner', body: { ...choose, pickId } });
    expect(res.status).toBe(200);
    expect(t.w.connections).toHaveLength(1);
    expect(t.w.connections[0]).toMatchObject({
      client_id: 'acme',
      platform: 'github',
      status: 'connected',
      label: 'acme-org/website',
      connected_by: 'u-owner',
      last_problem: null,
      settings: { repo: 'acme-org/website', baseBranch: 'main', contentDir: DEFAULT_CONTENT_DIR, installationId: 1001 },
    });
    noSecretsLeaked(t.w);
  });

  it('uses the chosen repo’s own default branch and an allowed custom folder', async () => {
    const t = setup();
    const pickId = await pickOf(t);
    await t.api('/api/connect/github/finish', { token: 'jwt-owner', body: { clientId: 'acme', installationId: 1001, repo: 'acme-org/docs', pickId, contentDir: './content/posts/' } });
    expect(t.w.connections[0]!.settings).toMatchObject({ baseBranch: 'trunk', contentDir: 'content/posts' });
  });

  it('refuses a folder that is not plain and safe, and keeps the choice usable', async () => {
    const t = setup();
    const pickId = await pickOf(t);
    for (const contentDir of ['../secrets', '/etc', 'a b', 'a//b', '..', 'a/../b', 'x'.repeat(200), 5]) {
      expect((await t.api('/api/connect/github/finish', { token: 'jwt-owner', body: { ...choose, pickId, contentDir } })).status).toBe(400);
    }
    expect(t.w.connections).toHaveLength(0);
    expect((await t.api('/api/connect/github/finish', { token: 'jwt-owner', body: { ...choose, pickId } })).status).toBe(200);
  });

  it('refuses a repo or installation GitHub did not confirm for this person, without using up the choice', async () => {
    const t = setup();
    const pickId = await pickOf(t);
    for (const bad of [{ repo: 'acme-org/readonly' }, { repo: 'other-org/site' }, { installationId: 2002 }, { repo: 'acme-org/website', installationId: 9 }]) {
      const res = await t.api('/api/connect/github/finish', { token: 'jwt-owner', body: { ...choose, pickId, ...bad } });
      expect(res.status).toBe(410);
    }
    expect(t.w.connections).toHaveLength(0);
    expect((await t.api('/api/connect/github/finish', { token: 'jwt-owner', body: { ...choose, pickId } })).status).toBe(200);
  });

  it('works once only', async () => {
    const t = setup();
    const pickId = await pickOf(t);
    expect((await t.api('/api/connect/github/finish', { token: 'jwt-owner', body: { ...choose, pickId } })).status).toBe(200);
    expect((await t.api('/api/connect/github/finish', { token: 'jwt-owner', body: { ...choose, pickId } })).status).toBe(410);
  });

  it('is private to the person who made the choice, and to owners', async () => {
    const t = setup();
    const pickId = await pickOf(t);
    t.w.members.push({ client_id: 'acme', user_id: 'u-stranger', role: 'owner' });
    expect((await t.api('/api/connect/github/finish', { token: 'jwt-stranger', body: { ...choose, pickId } })).status).toBe(410);
    expect(((await (await t.api('/api/connect/github/pending?clientId=acme', { token: 'jwt-stranger' })).json()) as { pending: unknown }).pending).toBeNull();
    expect((await t.api('/api/connect/github/finish', { token: 'jwt-reviewer', body: { ...choose, pickId } })).status).toBe(403);
    expect(t.w.connections).toHaveLength(0);
  });

  it('forgets a choice after 15 minutes', async () => {
    const t = setup();
    const pickId = await pickOf(t);
    t.w.now = new Date(t.w.now.getTime() + 16 * 60_000);
    expect(((await (await t.api('/api/connect/github/pending?clientId=acme', { token: 'jwt-owner' })).json()) as { pending: unknown }).pending).toBeNull();
    expect((await t.api('/api/connect/github/finish', { token: 'jwt-owner', body: { ...choose, pickId } })).status).toBe(410);
  });

  it('connecting again replaces the old connection and brings it back to connected', async () => {
    const t = setup();
    t.w.connections.push({ client_id: 'acme', platform: 'github', status: 'needs_attention', label: 'old/repo', settings: { repo: 'old/repo', installationId: 5 }, last_problem: 'broken' });
    const pickId = await pickOf(t);
    await t.api('/api/connect/github/finish', { token: 'jwt-owner', body: { ...choose, pickId } });
    expect(t.w.connections).toHaveLength(1);
    expect(t.w.connections[0]).toMatchObject({ status: 'connected', label: 'acme-org/website', last_problem: null });
  });

  it('can be disconnected by an owner only', async () => {
    const t = setup();
    t.w.connections.push({ client_id: 'acme', platform: 'github', status: 'connected', label: 'a/b', settings: {} });
    expect((await t.api('/api/connect/disconnect', { token: 'jwt-reviewer', body: { clientId: 'acme' } })).status).toBe(403);
    expect(t.w.connections[0]!.status).toBe('connected');
    expect((await t.api('/api/connect/disconnect', { token: 'jwt-owner', body: { clientId: 'acme' } })).status).toBe(200);
    expect(t.w.connections[0]!.status).toBe('disconnected');
  });
});

describe('the one-time GitHub App set-up', () => {
  const manifestFor = (code = 'mcode') => ({ id: 777, slug: 'lodestar-connect', client_id: 'Iv1.abc', client_secret: CLIENT_SECRET, pem: PEM, html_url: 'https://github.com/apps/lodestar-connect' });
  async function prepare(t: ReturnType<typeof setup>) {
    const res = await t.api('/api/admin/github-app/prepare', { token: 'jwt-admin', body: {} });
    const body = (await res.json()) as { action: string; manifest: Record<string, unknown> };
    return { res, ...body, state: new URL(body.action).searchParams.get('state')!, cookie: `${COOKIE}=${/lodestar_connect=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1]}` };
  }
  const created = (t: ReturnType<typeof setup>, params: Record<string, string>, cookie?: string) => t.api(`/api/admin/github-app/created?${new URLSearchParams(params)}`, cookie ? { cookie } : {});

  it('is for administrators only', async () => {
    const t = setup(new World());
    expect((await t.api('/api/admin/github-app/prepare', { token: 'jwt-owner', body: {} })).status).toBe(403);
    expect((await t.api('/api/admin/github-app/prepare', { token: 'jwt-admin', body: {} })).status).toBe(200);
  });

  it('prepares a manifest limited to what publishing needs, with callbacks on this site', async () => {
    const t = setup(new World());
    const p = await prepare(t);
    expect(p.action.startsWith('https://github.com/settings/apps/new?state=')).toBe(true);
    expect(p.manifest).toMatchObject({
      url: ORIGIN,
      redirect_url: `${ORIGIN}/api/admin/github-app/created`,
      callback_urls: [`${ORIGIN}/api/connect/github/callback`],
      request_oauth_on_install: true,
      public: true,
      default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    });
    expect(p.manifest).toEqual(buildManifest(ORIGIN));
    expect(Date.parse(t.w.attempts[0]!.expires_at as string) - t.w.now.getTime()).toBe(30 * 60_000);
  });

  it('stores the new app’s details in the Vault, the id last, and shows none of them to the browser', async () => {
    const t = setup(new World());
    t.w.manifests.set('mcode', manifestFor());
    const p = await prepare(t);
    const res = await created(t, { code: 'mcode', state: p.state }, p.cookie);
    expect(res.headers.get('location')).toBe('/?app=created');
    expect(t.w.vault).toEqual({ github_app_private_key: PEM, github_app_client_secret: CLIENT_SECRET, github_app_client_id: 'Iv1.abc', github_app_slug: 'lodestar-connect', github_app_id: '777' });
    expect(t.w.putOrder.at(-1)).toBe('github_app_id');
    noSecretsLeaked(t.w);
  });

  it('will not make a second app over the first', async () => {
    const t = setup(new World());
    t.w.manifests.set('mcode', manifestFor());
    const p = await prepare(t);
    await created(t, { code: 'mcode', state: p.state }, p.cookie);
    const again = await t.api('/api/admin/github-app/prepare', { token: 'jwt-admin', body: {} });
    expect(again.status).toBe(409);
    // Even a prepared link made earlier cannot overwrite it.
    const t2 = setup(new World());
    t2.w.manifests.set('m1', manifestFor());
    t2.w.manifests.set('m2', { ...manifestFor(), id: 999 });
    const a = await prepare(t2);
    const b = await prepare(t2);
    await created(t2, { code: 'm1', state: a.state }, a.cookie);
    expect(((await created(t2, { code: 'm2', state: b.state }, b.cookie)).headers.get('location'))).toBe('/?app=error&reason=app_exists');
    expect(t2.w.vault.github_app_id).toBe('777');
  });

  it('refuses a link used twice, expired, forged, from the wrong purpose, or from someone no longer an administrator', async () => {
    const t = setup(new World());
    t.w.manifests.set('m1', manifestFor());
    const p = await prepare(t);
    expect((await created(t, { code: 'm1', state: `${p.state}x` })).headers.get('location')).toBe('/?app=error&reason=invalid');
    const connectToken = await signToken(await deriveStateKey(SERVICE), 'connect', randomNonce());
    expect((await created(t, { code: 'm1', state: connectToken })).headers.get('location')).toBe('/?app=error&reason=invalid');
    t.w.admins.length = 0; // no longer an administrator
    expect((await created(t, { code: 'm1', state: p.state }, p.cookie)).headers.get('location')).toBe('/?app=error&reason=invalid');
    expect(t.w.vault).toEqual({});
    // the link was spent by the refusal above
    t.w.admins.push({ user_id: 'u-admin' });
    expect((await created(t, { code: 'm1', state: p.state }, p.cookie)).headers.get('location')).toBe('/?app=error&reason=expired');
    // expiry
    const q = await prepare(t);
    t.w.now = new Date(t.w.now.getTime() + 31 * 60_000);
    expect((await created(t, { code: 'm1', state: q.state }, q.cookie)).headers.get('location')).toBe('/?app=error&reason=expired');
  });

  it('saves nothing when GitHub will not finish creating the app', async () => {
    const t = setup(new World());
    const p = await prepare(t);
    expect((await created(t, { code: 'unknown', state: p.state }, p.cookie)).headers.get('location')).toBe('/?app=error&reason=convert_failed');
    expect(t.w.vault).toEqual({});
  });

  it('never looks finished when saving failed part-way (the id is the last thing saved)', async () => {
    const t = setup(new World());
    t.w.manifests.set('mcode', manifestFor());
    t.w.failPut = 'github_app_slug';
    const p = await prepare(t);
    expect((await created(t, { code: 'mcode', state: p.state }, p.cookie)).headers.get('location')).toBe('/?app=error&reason=save_failed');
    expect(t.w.vault.github_app_id).toBeUndefined();
    expect(((await (await t.api('/api/connect/config', { token: 'jwt-owner' })).json()) as { ready: boolean }).ready).toBe(false);
  });
});

describe('folder names and reasons', () => {
  it('accepts plain folders and defaults when none is given', () => {
    expect(cleanContentDir(undefined)).toBe(DEFAULT_CONTENT_DIR);
    expect(cleanContentDir('')).toBe(DEFAULT_CONTENT_DIR);
    expect(cleanContentDir('content/posts')).toBe('content/posts');
    expect(cleanContentDir(' ./src/content/insights/ ')).toBe('src/content/insights');
  });
  it('rejects anything that could escape or confuse a path', () => {
    for (const bad of ['..', '../x', 'a/..', '/abs', 'a b', 'a//b', 'a\\b', 'a?b', '.', 'a/./b', 42, {}]) expect(cleanContentDir(bad)).toBeUndefined();
  });
  it('has plain words for every reason the server can send, and a safe default for unknown ones', () => {
    for (const code of Object.keys(REASONS)) expect(reasonText(code).length).toBeGreaterThan(20);
    expect(reasonText('made-up')).toBe(REASONS.server);
    expect(reasonText(null)).toBe(REASONS.server);
  });
});
