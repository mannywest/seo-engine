import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionError, connectorFromConnection, fetchConnection, withConnection, type ConnectionRow } from '../src/connections.js';
import { createConnector } from '../src/connectors/index.js';
import { HostedConfigError, StateError } from '../src/stateStore.js';
import type { ClientProfile } from '../src/types.js';

const env = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_KEY: 'sb_secret_x' };
const row = (over: Partial<ConnectionRow> = {}): ConnectionRow => ({
  client_id: 'plerosis',
  platform: 'github',
  status: 'connected',
  label: 'mannywest/Plerosis-website',
  settings: { repo: 'mannywest/Plerosis-website', installationId: 4242 },
  last_problem: null,
  ...over,
});
const profile = (over: Record<string, unknown> = {}) => ({ id: 'plerosis', name: 'Plerosis', publish: { mode: 'review', inbox: true }, ...over }) as unknown as ClientProfile;

type Call = { url: string; headers: Record<string, string> };
function fakeFetch(respond: (c: Call) => { status?: number; json?: unknown; raw?: string }) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    const c = { url, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(c);
    const r = respond(c);
    const status = r.status ?? 200;
    return { ok: status < 300, status, statusText: '', text: async () => r.raw ?? (r.json === undefined ? '' : JSON.stringify(r.json)) } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

afterEach(() => vi.restoreAllMocks());

describe('connectorFromConnection', () => {
  it('turns a GitHub connection into a git connector signed in as the app', () => {
    const c = connectorFromConnection(row());
    expect(c).toMatchObject({ type: 'git', repo: 'mannywest/Plerosis-website', baseBranch: 'main', contentDir: 'src/content/blog', installationId: 4242 });
    expect(createConnector(c).type).toBe('git');
  });
  it('honours a different branch, content folder and app setting names', () => {
    const c = connectorFromConnection(row({ settings: { repo: 'a/b', installationId: 1, baseBranch: 'live', contentDir: 'posts', appIdEnv: 'X_ID', privateKeyEnv: 'X_KEY' } }));
    expect(c).toMatchObject({ baseBranch: 'live', contentDir: 'posts', appIdEnv: 'X_ID', privateKeyEnv: 'X_KEY' });
  });
  it('asks the client to connect again when the GitHub installation is missing', () => {
    expect(() => connectorFromConnection(row({ settings: { repo: 'a/b' } }))).toThrow(/connect again/);
  });
  it('maps WordPress, webhook and folder connections', () => {
    expect(connectorFromConnection(row({ platform: 'wordpress', settings: { siteUrl: 'https://x.com', userEnv: 'U', passwordEnv: 'P' } })).type).toBe('wordpress');
    expect(connectorFromConnection(row({ platform: 'webhook', settings: { url: 'https://x.com/hook', secretEnv: 'S' } })).type).toBe('webhook');
    expect(connectorFromConnection(row({ platform: 'folder', settings: { dir: '/tmp/x' } })).type).toBe('folder');
  });
  it('says plainly that Wix and Shopify are not available yet', () => {
    expect(() => connectorFromConnection(row({ platform: 'wix' }))).toThrow(/Wix sites is not available yet/);
    expect(() => connectorFromConnection(row({ platform: 'shopify' }))).toThrow(/Shopify sites is not available yet/);
  });
  it('rejects an incomplete saved connection with the label in the message', () => {
    expect(() => connectorFromConnection(row({ platform: 'webhook', settings: {} }))).toThrow(/mannywest\/Plerosis-website.*incomplete/);
  });
  it('never carries a secret value through, even if one was saved by mistake', () => {
    const c = connectorFromConnection(row({ settings: { repo: 'a/b', installationId: 1, token: 'ghp_leak', privateKey: 'KEY' } }));
    expect(JSON.stringify(c)).not.toContain('ghp_leak');
    expect(JSON.stringify(c)).not.toContain('KEY');
  });
});

describe('fetchConnection', () => {
  it('does nothing (and makes no request) when the engine is using local files', async () => {
    const f = fakeFetch(() => ({ json: [] }));
    expect(await fetchConnection('plerosis', { env: {}, fetch: f.fn })).toBeUndefined();
    expect(f.calls).toHaveLength(0);
  });
  it('asks for just this client, with the service key', async () => {
    const f = fakeFetch(() => ({ json: [row()] }));
    const got = await fetchConnection('weird id&x=1', { env, fetch: f.fn });
    expect(got?.platform).toBe('github');
    const call = f.calls[0]!;
    expect(call.url).toContain('/rest/v1/site_connections?');
    expect(call.url).toContain('client_id=eq.weird%20id%26x%3D1');
    expect(call.url).toContain('limit=1');
    expect(JSON.stringify(call.headers)).toContain('sb_secret_x');
  });
  it('returns nothing when the client has no row', async () => {
    expect(await fetchConnection('plerosis', { env, fetch: fakeFetch(() => ({ json: [] })).fn })).toBeUndefined();
  });
  it('stops on a failed read instead of falling back', async () => {
    await expect(fetchConnection('plerosis', { env, fetch: fakeFetch(() => ({ status: 500, raw: 'boom' })).fn })).rejects.toBeInstanceOf(StateError);
  });
  it('stops on a row it cannot understand', async () => {
    await expect(fetchConnection('plerosis', { env, fetch: fakeFetch(() => ({ json: [{ client_id: 'plerosis', platform: 'carrier-pigeon' }] })).fn })).rejects.toThrow(/could not be read/);
  });
  it('refuses a half set up database rather than guessing', async () => {
    await expect(fetchConnection('plerosis', { env: { SUPABASE_URL: 'https://x' }, fetch: fakeFetch(() => ({ json: [] })).fn })).rejects.toBeInstanceOf(HostedConfigError);
  });
});

describe('withConnection', () => {
  it('leaves the profile alone when there is no saved connection', async () => {
    const p = profile({ connector: { type: 'folder', dir: '/x' } });
    expect(await withConnection(p, { env, fetch: fakeFetch(() => ({ json: [] })).fn })).toBe(p);
  });
  it('uses the saved connection over the connector in the client file, without changing the original', async () => {
    const p = profile({ connector: { type: 'folder', dir: '/x' } });
    const out = await withConnection(p, { env, fetch: fakeFetch(() => ({ json: [row()] })).fn });
    expect((out.connector as { type: string }).type).toBe('git');
    expect((p.connector as { type: string }).type).toBe('folder');
  });
  it('throws a plain message when the connection needs attention and a delivery is about to happen', async () => {
    const f = fakeFetch(() => ({ json: [row({ status: 'needs_attention', last_problem: 'GitHub no longer lets the engine in' })] }));
    await expect(withConnection(profile(), { env, fetch: f.fn })).rejects.toThrow(/GitHub no longer lets the engine in.*connect again/);
    await expect(withConnection(profile(), { env, fetch: f.fn })).rejects.toBeInstanceOf(ConnectionError);
  });
  it('says the client disconnected when they did', async () => {
    const f = fakeFetch(() => ({ json: [row({ status: 'disconnected' })] }));
    await expect(withConnection(profile(), { env, fetch: f.fn })).rejects.toThrow(/disconnected their website/);
  });
  it('in lenient mode drops the connector and carries on so drafts still reach the inbox', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const p = profile({ connector: { type: 'folder', dir: '/x' } });
    const out = await withConnection(p, { env, strict: false, fetch: fakeFetch(() => ({ json: [row({ status: 'needs_attention' })] })).fn });
    expect(out.connector).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
