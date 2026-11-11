import { deriveStateKey, randomNonce, signToken, verifyToken } from './crypto';
import { Db } from './supabase';
import { convertManifest, exchangeCode, GithubError, listInstallations, listRepos, type Repo } from './github';
import type { Deps, Env, Fetch } from './types';
import { REASONS, type ReasonCode } from '../src/reasons';

/**
 * The server piece behind "Connect your website" (GitHub first).
 *
 * The trip: the signed-in owner taps Connect -> we send them to GitHub to sign in and allow the app -> GitHub sends them
 * back to `callback` with a one-time code -> we ask GitHub (not the address bar) which installations that person can reach ->
 * they pick one repo -> `finish` records the connection. Only the service key writes to the database; nobody logged in can.
 */

const MINUTE = 60_000;
export const COOKIE = 'lodestar_connect';
export const DEFAULT_CONTENT_DIR = 'src/content/blog';
const CONNECT_MINUTES = 15;
const SETUP_MINUTES = 30;
const MAX_CANDIDATES = 200;

interface Ctx {
  db: Db;
  key: CryptoKey;
  f: Fetch;
  now: () => Date;
  origin: string;
}

interface Attempt {
  nonce: string;
  user_id: string;
  client_id: string | null;
  leg: number;
  candidates?: Repo[] | null;
}

type GithubApp = { id: string; slug: string; clientId: string; clientSecret: string };

// ---- small helpers -----------------------------------------------------------------------------

const enc = encodeURIComponent;
const noStore = { 'Cache-Control': 'no-store' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...noStore } });
}

function redirect(location: string, cookie?: string): Response {
  const h = new Headers({ Location: location, ...noStore });
  if (cookie) h.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers: h });
}

const setCookie = (token: string) => `${COOKIE}=${token}; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=${SETUP_MINUTES * 60}`;
const clearCookie = `${COOKIE}=; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=') || undefined;
  }
  return undefined;
}

/**
 * The one-time value coming back. GitHub echoes our `state` when it can; a cookie set at the start is the fallback
 * (for example when GitHub's phone app opens the link in a different browser, `state` alone is enough).
 * If both arrive and disagree, something is wrong, so it is refused.
 */
function tokenFrom(req: Request, url: URL): string | 'mismatch' | undefined {
  const fromState = url.searchParams.get('state') || undefined;
  const fromCookie = readCookie(req.headers.get('cookie'), COOKIE);
  if (fromState && fromCookie && fromState !== fromCookie) return 'mismatch';
  return fromState ?? fromCookie;
}

async function readJson(req: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const CLIENT_ID = /^[A-Za-z0-9._-]{1,64}$/;
const iso = (c: Ctx, plusMinutes = 0) => new Date(c.now().getTime() + plusMinutes * MINUTE).toISOString();

/** Keeps a folder name to plain, safe path pieces. Returns undefined for anything else (no "..", no leading slash, no odd characters). */
export function cleanContentDir(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_CONTENT_DIR;
  if (typeof raw !== 'string') return undefined;
  const dir = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (!dir || dir.length > 120) return undefined;
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(dir)) return undefined;
  if (dir.split('/').some((p) => p === '.' || p === '..')) return undefined;
  return dir;
}

// ---- who is asking -----------------------------------------------------------------------------

async function userOf(req: Request, c: Ctx): Promise<{ id: string } | Response> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  if (!m) return json(401, { error: 'Please sign in again.', code: 'signin' });
  const user = await c.db.userFromToken(m[1]!);
  return user ?? json(401, { error: 'Please sign in again.', code: 'signin' });
}

async function isAdmin(c: Ctx, userId: string): Promise<boolean> {
  return (await c.db.select('platform_admins', `user_id=eq.${enc(userId)}&select=user_id&limit=1`)).length > 0;
}

/** Only an owner of the business may connect or disconnect its website (a reviewer may not). */
async function requireOwner(c: Ctx, userId: string, clientId: unknown): Promise<string | Response> {
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) return json(400, { error: 'That business was not recognised.' });
  const rows = await c.db.select<{ role: string }>('client_members', `client_id=eq.${enc(clientId)}&user_id=eq.${enc(userId)}&select=role&limit=1`);
  if (!rows[0]) return json(403, { error: 'You do not have access to that business.' });
  if (rows[0].role !== 'owner') return json(403, { error: 'Only the owner of the business can connect its website.' });
  return clientId;
}

// ---- the GitHub App's details (kept in the Vault) -------------------------------------------------

async function secret(c: Ctx, name: string): Promise<string | undefined> {
  const v = await c.db.rpc<string | null>('lodestar_get_secret', { p_name: name });
  return typeof v === 'string' && v ? v : undefined;
}

async function loadApp(c: Ctx): Promise<GithubApp | undefined> {
  const [id, slug, clientId, clientSecret] = await Promise.all(['github_app_id', 'github_app_slug', 'github_app_client_id', 'github_app_client_secret'].map((n) => secret(c, n)));
  return id && slug && clientId && clientSecret ? { id, slug, clientId, clientSecret } : undefined;
}

// ---- one-time attempts ---------------------------------------------------------------------------

async function createAttempt(c: Ctx, a: { kind: 'github_connect' | 'github_app_setup' | 'github_pick'; userId: string; clientId?: string; leg?: number; minutes: number; candidates?: Repo[] }): Promise<string> {
  const nonce = randomNonce();
  await c.db.insert('connect_attempts', {
    nonce,
    kind: a.kind,
    client_id: a.clientId ?? null,
    user_id: a.userId,
    leg: a.leg ?? 1,
    ...(a.candidates ? { candidates: a.candidates } : {}),
    expires_at: iso(c, a.minutes),
  });
  return nonce;
}

/** Marks an attempt used, once. If it was already used, has expired or is the wrong kind, nothing matches and we get undefined. */
async function consume(c: Ctx, nonce: string, kind: string): Promise<Attempt | undefined> {
  const rows = await c.db.patch<Attempt>('connect_attempts', `nonce=eq.${enc(nonce)}&kind=eq.${kind}&consumed_at=is.null&expires_at=gt.${enc(iso(c))}`, { consumed_at: iso(c) });
  return rows[0];
}

// ---- endpoints: connecting a site -----------------------------------------------------------------

/** What the Connect screen needs to know first: is connecting switched on, and may this person do the one-time app set-up. */
export async function config(req: Request, c: Ctx): Promise<Response> {
  const user = await userOf(req, c);
  if (user instanceof Response) return user;
  const [admin, app] = await Promise.all([isAdmin(c, user.id), loadApp(c)]);
  return json(200, { ready: !!app, admin });
}

export async function startGithub(req: Request, c: Ctx): Promise<Response> {
  const user = await userOf(req, c);
  if (user instanceof Response) return user;
  const body = await readJson(req);
  const clientId = await requireOwner(c, user.id, body?.clientId);
  if (clientId instanceof Response) return clientId;
  const app = await loadApp(c);
  if (!app) return json(503, { error: REASON('app_missing'), code: 'app_missing' });

  const nonce = await createAttempt(c, { kind: 'github_connect', userId: user.id, clientId, minutes: CONNECT_MINUTES });
  const token = await signToken(c.key, 'connect', nonce);
  const url = `https://github.com/login/oauth/authorize?client_id=${enc(app.clientId)}&redirect_uri=${enc(`${c.origin}/api/connect/github/callback`)}&state=${enc(token)}`;
  return new Response(JSON.stringify({ url }), { status: 200, headers: { 'Content-Type': 'application/json', ...noStore, 'Set-Cookie': setCookie(token) } });
}

const failConnect = (reason: ReasonCode) => redirect(`/?connect=error&reason=${reason}`, clearCookie);

export async function githubCallback(req: Request, c: Ctx, url: URL): Promise<Response> {
  try {
    if (url.searchParams.get('error')) return failConnect('denied');
    const t = tokenFrom(req, url);
    if (t === 'mismatch') return failConnect('invalid');
    if (!t) return failConnect('expired');
    const nonce = await verifyToken(c.key, 'connect', t);
    if (!nonce) return failConnect('invalid');
    const attempt = await consume(c, nonce, 'github_connect');
    if (!attempt || !attempt.client_id) return failConnect('expired');
    const code = url.searchParams.get('code');
    if (!code) return failConnect('invalid');
    const app = await loadApp(c);
    if (!app) return failConnect('app_missing');

    let userToken: string;
    try {
      userToken = await exchangeCode(app, code, `${c.origin}/api/connect/github/callback`, c.f);
    } catch (e) {
      return failConnect(e instanceof GithubError && e.kind === 'denied' ? 'denied' : 'github_failed');
    }

    // Ask GitHub which installations this person can reach. The installation_id in the address is only a hint to narrow
    // the list: it can be edited by anyone, so it is never trusted on its own.
    const installations = await listInstallations(userToken, c.f);
    const hinted = Number(url.searchParams.get('installation_id'));
    const hasHint = Number.isInteger(hinted) && hinted > 0;
    const use = hasHint ? installations.filter((i) => i.id === hinted) : installations;
    if (hasHint && !use.length) return failConnect('not_yours');

    const repos = (await Promise.all(use.map((i) => listRepos(userToken, i, c.f)))).flat();
    if (!repos.length) {
      if (hasHint || attempt.leg >= 2) return failConnect('no_repos');
      // The app is not installed anywhere this person can reach yet: send them to install it, once.
      const next = await createAttempt(c, { kind: 'github_connect', userId: attempt.user_id, clientId: attempt.client_id, leg: 2, minutes: CONNECT_MINUTES });
      const token = await signToken(c.key, 'connect', next);
      return redirect(`https://github.com/apps/${enc(app.slug)}/installations/new?state=${enc(token)}`, setCookie(token));
    }

    repos.sort((a, b) => a.repo.localeCompare(b.repo));
    await createAttempt(c, { kind: 'github_pick', userId: attempt.user_id, clientId: attempt.client_id, minutes: CONNECT_MINUTES, candidates: repos.slice(0, MAX_CANDIDATES) });
    return redirect('/?connect=pick', clearCookie);
  } catch (e) {
    console.error('connect callback failed:', e instanceof Error ? e.message : 'unknown');
    return failConnect('server');
  }
}

/** The repos GitHub confirmed for this person, waiting for them to choose. */
export async function pending(req: Request, c: Ctx, url: URL): Promise<Response> {
  const user = await userOf(req, c);
  if (user instanceof Response) return user;
  const clientId = await requireOwner(c, user.id, url.searchParams.get('clientId'));
  if (clientId instanceof Response) return clientId;
  const rows = await c.db.select<Attempt>('connect_attempts', `kind=eq.github_pick&client_id=eq.${enc(clientId)}&user_id=eq.${enc(user.id)}&consumed_at=is.null&expires_at=gt.${enc(iso(c))}&order=created_at.desc&limit=1&select=nonce,candidates`);
  const row = rows[0];
  return json(200, { pending: row ? { pickId: row.nonce, candidates: row.candidates ?? [], defaultContentDir: DEFAULT_CONTENT_DIR } : null });
}

export async function finish(req: Request, c: Ctx): Promise<Response> {
  const user = await userOf(req, c);
  if (user instanceof Response) return user;
  const body = await readJson(req);
  const clientId = await requireOwner(c, user.id, body?.clientId);
  if (clientId instanceof Response) return clientId;
  const { pickId, repo, installationId } = body ?? {};
  const contentDir = cleanContentDir(body?.contentDir);
  if (typeof pickId !== 'string' || typeof repo !== 'string' || typeof installationId !== 'number') return json(400, { error: 'Please choose a repository first.' });
  if (!contentDir) return json(400, { error: 'That folder name is not valid. Use letters, numbers, dashes and slashes, for example src/content/blog.' });

  const rows = await c.db.select<Attempt>('connect_attempts', `nonce=eq.${enc(pickId)}&kind=eq.github_pick&client_id=eq.${enc(clientId)}&user_id=eq.${enc(user.id)}&consumed_at=is.null&expires_at=gt.${enc(iso(c))}&select=nonce,candidates`);
  const choice = rows[0]?.candidates?.find((r) => r.repo === repo && r.installationId === installationId);
  if (!choice) return json(410, { error: 'That choice has expired or is not one GitHub confirmed for you. Tap Connect to start again.', code: 'expired' });
  if (!(await consume(c, pickId, 'github_pick'))) return json(410, { error: 'That choice was already used. Tap Connect to start again.', code: 'expired' });

  await c.db.upsert(
    'site_connections',
    {
      client_id: clientId,
      platform: 'github',
      status: 'connected',
      label: choice.repo,
      settings: { repo: choice.repo, baseBranch: choice.defaultBranch, contentDir, installationId: choice.installationId },
      connected_by: user.id,
      connected_at: iso(c),
      last_checked_at: null,
      last_problem: null,
    },
    'client_id',
  );
  return json(200, { ok: true, label: choice.repo, contentDir });
}

export async function disconnect(req: Request, c: Ctx): Promise<Response> {
  const user = await userOf(req, c);
  if (user instanceof Response) return user;
  const clientId = await requireOwner(c, user.id, (await readJson(req))?.clientId);
  if (clientId instanceof Response) return clientId;
  await c.db.patch('site_connections', `client_id=eq.${enc(clientId)}`, { status: 'disconnected' });
  return json(200, { ok: true });
}

// ---- endpoints: the one-time GitHub App set-up -----------------------------------------------------

/** The app's description for GitHub's "create app from a manifest" screen. The owner can still edit the name there. */
export function buildManifest(origin: string): Record<string, unknown> {
  return {
    name: 'Lodestar Website Connect',
    url: origin,
    description: 'Opens a pull request on your website with each article you approve. It never merges anything.',
    redirect_url: `${origin}/api/admin/github-app/created`,
    callback_urls: [`${origin}/api/connect/github/callback`],
    request_oauth_on_install: true,
    public: true,
    // Switched off: nothing listens for it yet. Listed so the manifest has the shape GitHub documents.
    hook_attributes: { url: `${origin}/api/github/webhook`, active: false },
    default_events: [],
    // Exactly what publishing needs: add files on a new branch, open a pull request. No merge rights, no settings.
    default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
  };
}

export async function prepareApp(req: Request, c: Ctx): Promise<Response> {
  const user = await userOf(req, c);
  if (user instanceof Response) return user;
  if (!(await isAdmin(c, user.id))) return json(403, { error: 'Only a set-up administrator can create the GitHub App.' });
  if (await secret(c, 'github_app_id')) return json(409, { error: REASON('app_exists'), code: 'app_exists' });
  const nonce = await createAttempt(c, { kind: 'github_app_setup', userId: user.id, minutes: SETUP_MINUTES });
  const token = await signToken(c.key, 'appsetup', nonce);
  return new Response(JSON.stringify({ action: `https://github.com/settings/apps/new?state=${enc(token)}`, manifest: buildManifest(c.origin) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...noStore, 'Set-Cookie': setCookie(token) },
  });
}

const failApp = (reason: ReasonCode) => redirect(`/?app=error&reason=${reason}`, clearCookie);

export async function appCreated(req: Request, c: Ctx, url: URL): Promise<Response> {
  try {
    const t = tokenFrom(req, url);
    if (t === 'mismatch') return failApp('invalid');
    if (!t) return failApp('expired');
    const nonce = await verifyToken(c.key, 'appsetup', t);
    if (!nonce) return failApp('invalid');
    const attempt = await consume(c, nonce, 'github_app_setup');
    if (!attempt) return failApp('expired');
    if (!(await isAdmin(c, attempt.user_id))) return failApp('invalid');
    const code = url.searchParams.get('code');
    if (!code) return failApp('invalid');
    if (await secret(c, 'github_app_id')) return failApp('app_exists');

    let created;
    try {
      created = await convertManifest(code, c.f);
    } catch {
      return failApp('convert_failed');
    }
    try {
      // The id goes last: "created" is judged by it, so a half-saved set never looks finished.
      for (const [name, value] of [
        ['github_app_private_key', created.pem],
        ['github_app_client_secret', created.clientSecret],
        ['github_app_client_id', created.clientId],
        ['github_app_slug', created.slug],
        ['github_app_id', String(created.id)],
      ] as const) {
        await c.db.rpc('lodestar_put_secret', { p_name: name, p_value: value });
      }
    } catch {
      return failApp('save_failed');
    }
    return redirect('/?app=created', clearCookie);
  } catch (e) {
    console.error('app set-up failed:', e instanceof Error ? e.message : 'unknown');
    return failApp('server');
  }
}

const REASON = (code: ReasonCode): string => REASONS[code];

/** Builds the working context for one request, or says plainly that the server settings are missing. */
export async function contextFor(req: Request, env: Env, deps: Deps = {}): Promise<Ctx | Response> {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_KEY?.trim();
  if (!url || !key) return json(503, { error: 'Connecting a website is not switched on yet: the site is missing its server settings.', code: 'not_configured' });
  const f = deps.fetch ?? fetch;
  return { db: new Db(url, key, f), key: await deriveStateKey(key), f, now: deps.now ?? (() => new Date()), origin: new URL(req.url).origin };
}
