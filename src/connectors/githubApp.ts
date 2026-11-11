import { createSign } from 'node:crypto';
import type { Env, Fetch } from './types.js';

/**
 * Signs in as a GitHub App, so a client never has to make or paste a token.
 *
 * How it works, in plain terms: the engine holds one app key (kept in the Supabase Vault or a GitHub secret, never in a client file).
 * When a client taps "Connect GitHub", GitHub records that this app may touch their chosen repo and gives us an installation number.
 * At publish time the engine proves who it is with the app key, and GitHub hands back a key that works for ONE hour on ONE repo.
 * That short-lived key is never stored.
 */

export const DEFAULT_APP_ID_ENV = 'GITHUB_APP_ID';
export const DEFAULT_APP_KEY_ENV = 'GITHUB_APP_PRIVATE_KEY';

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** Secrets pasted through a single-line field often carry "\n" as two characters; turn them back into real line breaks. */
export function normalisePrivateKey(raw: string): string {
  return raw.replace(/\\n/g, '\n').trim();
}

/** A signed 9-minute proof that we are the app (GitHub allows at most 10 minutes). Starts a minute early to forgive clock drift. */
export function createAppJwt(appId: string, privateKeyPem: string, nowMs: number = Date.now()): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 600 - 60, iss: appId }));
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(normalisePrivateKey(privateKeyPem));
  return `${head}.${body}.${b64url(signature)}`;
}

/** Plain-English problems with the app settings, or an empty list when the id and key are present. */
export function appSettingsProblems(env: Env, appIdEnv = DEFAULT_APP_ID_ENV, keyEnv = DEFAULT_APP_KEY_ENV): string[] {
  const problems: string[] = [];
  if (!env[appIdEnv]) problems.push(`Set ${appIdEnv} to the engine's GitHub App id.`);
  if (!env[keyEnv]) problems.push(`Set ${keyEnv} to the engine's GitHub App private key.`);
  return problems;
}

export interface AppTokenOptions {
  appId: string;
  privateKey: string;
  installationId: number;
  /** "owner/name": the one repo the short-lived key is limited to. */
  repo: string;
  fetchFn?: Fetch;
  /** For tests. */
  now?: () => number;
}

/** Gives out a working repo key, asking GitHub for a new one only when the last is about to expire. */
export class AppTokenSource {
  private cached?: { token: string; expiresAt: number };
  private readonly fetchFn: Fetch;
  private readonly now: () => number;

  constructor(private opts: AppTokenOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - this.now() > 5 * 60_000) return this.cached.token;
    const { appId, privateKey, installationId, repo } = this.opts;
    const name = repo.split('/')[1] ?? repo;
    let res: Response;
    try {
      res = await this.fetchFn(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${createAppJwt(appId, privateKey, this.now())}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'seo-engine',
        },
        // Ask only for what publishing needs, on the one repo: files in a new branch, then a pull request. Merging is the client's call.
        body: JSON.stringify({ repositories: [name], permissions: { contents: 'write', pull_requests: 'write' } }),
      });
    } catch (e) {
      throw new Error(`Could not reach GitHub to sign in: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 401) throw new Error("GitHub did not accept the engine's app sign-in (the app id or key is wrong).");
    if (res.status === 404) throw new Error('The engine\'s GitHub app is no longer installed on this site. The client may have removed it; ask them to connect again.');
    if (res.status === 422) throw new Error(`The client has not allowed the engine to use ${repo}. Ask them to connect again and choose that repo.`);
    if (!res.ok) throw new Error(`GitHub sign-in failed (${res.status}).`);
    const json = (await res.json()) as { token?: string; expires_at?: string };
    if (!json.token) throw new Error('GitHub sign-in succeeded but returned no key.');
    const expiresAt = json.expires_at ? Date.parse(json.expires_at) : this.now() + 55 * 60_000;
    this.cached = { token: json.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : this.now() + 55 * 60_000 };
    return json.token;
  }
}
