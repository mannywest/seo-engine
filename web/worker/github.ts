import type { Fetch } from './types';

const API = 'https://api.github.com';

/** `denied`: the person (or GitHub) said no, or the one-time code was bad. `failed`: anything else. */
export class GithubError extends Error {
  constructor(
    message: string,
    readonly kind: 'denied' | 'failed',
  ) {
    super(message);
  }
}

const headers = (token?: string): Record<string, string> => ({
  Accept: 'application/vnd.github+json',
  'User-Agent': 'lodestar-connect',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

/** Swaps the one-time code GitHub sent back for a key that speaks for the signed-in GitHub user. It is used within this request and never stored. */
export async function exchangeCode(app: { clientId: string; clientSecret: string }, code: string, redirectUri: string, f: Fetch): Promise<string> {
  let res: Response;
  try {
    res = await f('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { ...headers(), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: redirectUri }),
    });
  } catch {
    throw new GithubError('Could not reach GitHub.', 'failed');
  }
  if (!res.ok) throw new GithubError(`GitHub refused the sign-in (${res.status}).`, 'failed');
  const json = (await res.json()) as { access_token?: unknown; error?: unknown };
  if (typeof json.access_token === 'string' && json.access_token) return json.access_token;
  // GitHub answers 200 with an error name for a used-up or wrong code.
  throw new GithubError('GitHub did not accept the sign-in.', json.error === 'bad_verification_code' || json.error === 'access_denied' ? 'denied' : 'failed');
}

async function getJson<T>(url: string, token: string, f: Fetch): Promise<T> {
  let res: Response;
  try {
    res = await f(url, { headers: headers(token) });
  } catch {
    throw new GithubError('Could not reach GitHub.', 'failed');
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) throw new GithubError(`GitHub would not show that (${res.status}).`, 'denied');
  if (!res.ok) throw new GithubError(`GitHub returned ${res.status}.`, 'failed');
  return (await res.json()) as T;
}

export interface Installation {
  id: number;
  account: string;
}

/** The installations of OUR app that this signed-in GitHub user can reach. This, not a number in the address bar, is what proves ownership. */
export async function listInstallations(token: string, f: Fetch): Promise<Installation[]> {
  const out: Installation[] = [];
  for (let page = 1; page <= 5; page++) {
    const json = await getJson<{ installations?: { id?: unknown; account?: { login?: unknown } | null }[] }>(`${API}/user/installations?per_page=100&page=${page}`, token, f);
    const list = json.installations ?? [];
    for (const i of list) if (typeof i.id === 'number') out.push({ id: i.id, account: typeof i.account?.login === 'string' ? i.account.login : 'unknown' });
    if (list.length < 100) break;
  }
  return out;
}

export interface Repo {
  installationId: number;
  account: string;
  repo: string;
  defaultBranch: string;
}

/** The repos in one installation that this person can write to. Archived repos and ones they can only read are left out. */
export async function listRepos(token: string, inst: Installation, f: Fetch): Promise<Repo[]> {
  const out: Repo[] = [];
  for (let page = 1; page <= 5; page++) {
    const json = await getJson<{ repositories?: { full_name?: unknown; default_branch?: unknown; archived?: unknown; permissions?: { push?: unknown; admin?: unknown } | null }[] }>(
      `${API}/user/installations/${inst.id}/repositories?per_page=100&page=${page}`,
      token,
      f,
    );
    const list = json.repositories ?? [];
    for (const r of list) {
      const writable = r.permissions?.push === true || r.permissions?.admin === true;
      if (typeof r.full_name === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r.full_name) && !r.archived && writable) {
        out.push({ installationId: inst.id, account: inst.account, repo: r.full_name, defaultBranch: typeof r.default_branch === 'string' && r.default_branch ? r.default_branch : 'main' });
      }
    }
    if (list.length < 100) break;
  }
  return out;
}

export interface CreatedApp {
  id: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  pem: string;
}

/** Collects the new app's details, once, using the temporary code GitHub sent back. The private key is only ever shown here. */
export async function convertManifest(code: string, f: Fetch): Promise<CreatedApp> {
  let res: Response;
  try {
    res = await f(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', headers: headers() });
  } catch {
    throw new GithubError('Could not reach GitHub.', 'failed');
  }
  if (!res.ok) throw new GithubError(`GitHub would not finish creating the app (${res.status}).`, res.status === 404 || res.status === 422 ? 'denied' : 'failed');
  const j = (await res.json()) as { id?: unknown; slug?: unknown; html_url?: unknown; client_id?: unknown; client_secret?: unknown; pem?: unknown };
  const slug = typeof j.slug === 'string' && j.slug ? j.slug : typeof j.html_url === 'string' ? (j.html_url.split('/').filter(Boolean).pop() ?? '') : '';
  if (typeof j.id !== 'number' || !slug || typeof j.client_id !== 'string' || typeof j.client_secret !== 'string' || typeof j.pem !== 'string' || !j.pem) {
    throw new GithubError('GitHub created the app but did not return all its details.', 'failed');
  }
  return { id: j.id, slug, clientId: j.client_id, clientSecret: j.client_secret, pem: j.pem };
}
