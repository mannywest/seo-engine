import type { SupabaseClient } from '@supabase/supabase-js';
import { reasonText } from './reasons';

/** What the Connect screen asks the server piece (web/worker). Every call carries the person's own sign-in; the server checks it. */

export interface ConnectConfig {
  /** The GitHub App exists, so connecting can work. */
  ready: boolean;
  /** This person may do the one-time app set-up. */
  admin: boolean;
  /** The site itself is missing its server settings. */
  notConfigured?: boolean;
}
export interface Candidate {
  installationId: number;
  account: string;
  repo: string;
  defaultBranch: string;
}
export interface PendingPick {
  pickId: string;
  candidates: Candidate[];
  defaultContentDir: string;
}

export class ConnectApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** The pages we are willing to send a person to. A reply that points anywhere else is refused, not followed. */
export const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize?';
export const GITHUB_NEW_APP = 'https://github.com/settings/apps/new?state=';
export const safeGithubUrl = (url: unknown, prefix: string): url is string => typeof url === 'string' && url.startsWith(prefix);

export class ConnectApi {
  constructor(
    private readonly db: SupabaseClient,
    private readonly f: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async call<T>(path: string, body?: unknown): Promise<T> {
    const { data } = await this.db.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new ConnectApiError('Please sign in again.', 401, 'signin');
    let res: Response;
    try {
      res = await this.f(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ConnectApiError('Could not reach the server. Check your connection and try again.', 0);
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (!res.ok) throw new ConnectApiError(json.error ?? `Something went wrong (${res.status}).`, res.status, json.code);
    return json as T;
  }

  async config(): Promise<ConnectConfig> {
    try {
      return await this.call<ConnectConfig>('/api/connect/config');
    } catch (e) {
      if (e instanceof ConnectApiError && e.code === 'not_configured') return { ready: false, admin: false, notConfigured: true };
      throw e;
    }
  }

  /** The GitHub address to send the person to. */
  async startGithub(clientId: string): Promise<string> {
    const { url } = await this.call<{ url: unknown }>('/api/connect/github/start', { clientId });
    if (!safeGithubUrl(url, GITHUB_AUTHORIZE)) throw new ConnectApiError('The server sent an unexpected address, so nothing was opened.', 0);
    return url;
  }

  async pending(clientId: string): Promise<PendingPick | null> {
    return (await this.call<{ pending: PendingPick | null }>(`/api/connect/github/pending?clientId=${encodeURIComponent(clientId)}`)).pending;
  }

  async finish(a: { clientId: string; pickId: string; installationId: number; repo: string; contentDir?: string }): Promise<{ label: string; contentDir: string }> {
    return this.call('/api/connect/github/finish', a);
  }

  async disconnect(clientId: string): Promise<void> {
    await this.call('/api/connect/disconnect', { clientId });
  }

  async prepareApp(): Promise<{ action: string; manifest: Record<string, unknown> }> {
    const r = await this.call<{ action: unknown; manifest: Record<string, unknown> }>('/api/admin/github-app/prepare', {});
    if (!safeGithubUrl(r.action, GITHUB_NEW_APP)) throw new ConnectApiError('The server sent an unexpected address, so nothing was opened.', 0);
    return { action: r.action, manifest: r.manifest };
  }
}

/** Sends the person's browser to GitHub's "create app" screen, carrying the app's description. */
export function postManifest(action: string, manifest: unknown): void {
  if (!safeGithubUrl(action, GITHUB_NEW_APP)) throw new Error('Refusing to send the app description anywhere but GitHub.');
  const form = document.createElement('form');
  form.method = 'post';
  form.action = action;
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'manifest';
  input.value = JSON.stringify(manifest);
  form.append(input);
  document.body.append(form);
  form.submit();
}

/** What the address says when GitHub (via the server) has sent the person back here. */
export type Notice = { kind: 'pick' } | { kind: 'error'; text: string } | { kind: 'app-created' } | { kind: 'app-error'; text: string };

export function readNotice(search: string): Notice | undefined {
  const p = new URLSearchParams(search);
  const connect = p.get('connect');
  const app = p.get('app');
  if (connect === 'pick') return { kind: 'pick' };
  if (connect === 'error') return { kind: 'error', text: reasonText(p.get('reason')) };
  if (app === 'created') return { kind: 'app-created' };
  if (app === 'error') return { kind: 'app-error', text: reasonText(p.get('reason')) };
  return undefined;
}
