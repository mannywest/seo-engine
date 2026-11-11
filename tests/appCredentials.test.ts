import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppCredentialsError, ensureAppCredentials } from '../src/appCredentials.js';
import { ConnectionError, withConnection } from '../src/connections.js';
import type { ClientProfile } from '../src/types.js';

const HOSTED = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_KEY: 'sb_secret_x' };
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';

type Call = { url: string; body: unknown; headers: Record<string, string> };
/** A pretend Supabase that answers the Vault helper. `vault` maps secret name to value; a missing name returns null. */
function fakeVault(vault: Record<string, string>, status = 200) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body, headers: (init.headers ?? {}) as Record<string, string> });
    if (status !== 200) return { ok: false, status, text: async () => 'secret-name-and-context-we-must-not-echo' } as Response;
    const v = vault[(body as { p_name: string }).p_name];
    return { ok: true, status: 200, text: async () => JSON.stringify(v ?? null) } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

afterEach(() => vi.restoreAllMocks());

describe('ensureAppCredentials', () => {
  it('fills the app id and key from the Vault, asking only the Vault helper, with the service key', async () => {
    const v = fakeVault({ github_app_id: '123', github_app_private_key: PEM });
    const env: Record<string, string | undefined> = { ...HOSTED };
    await ensureAppCredentials({ env, fetch: v.fn });
    expect(env.GITHUB_APP_ID).toBe('123');
    expect(env.GITHUB_APP_PRIVATE_KEY).toBe(PEM);
    expect(v.calls.map((c) => c.url)).toEqual(['https://proj.supabase.co/rest/v1/rpc/lodestar_get_secret', 'https://proj.supabase.co/rest/v1/rpc/lodestar_get_secret']);
    expect(v.calls.map((c) => (c.body as { p_name: string }).p_name)).toEqual(['github_app_id', 'github_app_private_key']);
    expect(JSON.stringify(v.calls[0]!.headers)).toContain('sb_secret_x');
  });

  it('never replaces a value the run already has (a GitHub secret wins), and fetches only what is missing', async () => {
    const v = fakeVault({ github_app_id: 'from-vault', github_app_private_key: 'from-vault-key' });
    const env: Record<string, string | undefined> = { ...HOSTED, GITHUB_APP_ID: 'mine' };
    await ensureAppCredentials({ env, fetch: v.fn });
    expect(env.GITHUB_APP_ID).toBe('mine');
    expect(env.GITHUB_APP_PRIVATE_KEY).toBe('from-vault-key');
    expect(v.calls).toHaveLength(1);
  });

  it('treats a blank value (an unset GitHub secret arrives as "") as missing', async () => {
    const v = fakeVault({ github_app_id: '5', github_app_private_key: PEM });
    const env: Record<string, string | undefined> = { ...HOSTED, GITHUB_APP_ID: '', GITHUB_APP_PRIVATE_KEY: '  ' };
    await ensureAppCredentials({ env, fetch: v.fn });
    expect(env.GITHUB_APP_ID).toBe('5');
    expect(env.GITHUB_APP_PRIVATE_KEY).toBe(PEM);
  });

  it('makes no request when both are already set', async () => {
    const v = fakeVault({});
    await ensureAppCredentials({ env: { ...HOSTED, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'k' }, fetch: v.fn });
    expect(v.calls).toHaveLength(0);
  });

  it('makes no request when the engine is using local files (no hosted database)', async () => {
    const v = fakeVault({ github_app_id: '1' });
    const env: Record<string, string | undefined> = {};
    await ensureAppCredentials({ env, fetch: v.fn });
    expect(v.calls).toHaveLength(0);
    expect(env.GITHUB_APP_ID).toBeUndefined();
  });

  it('fills the variables a connector names, not the defaults', async () => {
    const v = fakeVault({ github_app_id: '9', github_app_private_key: PEM });
    const env: Record<string, string | undefined> = { ...HOSTED };
    await ensureAppCredentials({ env, fetch: v.fn, appIdEnv: 'X_ID', privateKeyEnv: 'X_KEY' });
    expect(env.X_ID).toBe('9');
    expect(env.X_KEY).toBe(PEM);
    expect(env.GITHUB_APP_ID).toBeUndefined();
  });

  it('leaves a variable unset when the Vault has nothing yet, so the connector can say so itself', async () => {
    const env: Record<string, string | undefined> = { ...HOSTED };
    await ensureAppCredentials({ env, fetch: fakeVault({}).fn });
    expect(env.GITHUB_APP_ID).toBeUndefined();
    expect(env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
  });

  it('fails in plain English when the database refuses, without echoing what it said', async () => {
    const err = await ensureAppCredentials({ env: { ...HOSTED }, fetch: fakeVault({}, 404).fn }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(AppCredentialsError);
    expect((err as Error).message).toMatch(/status 404.*schema\.sql/);
    expect((err as Error).message).not.toContain('secret-name-and-context');
  });

  it('turns a network failure into the same kind of plain message', async () => {
    const down = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    await expect(ensureAppCredentials({ env: { ...HOSTED }, fetch: down })).rejects.toThrow(/Could not reach the database.*socket hang up/);
  });
});

describe('withConnection and the app key', () => {
  const profile = { id: 'plerosis', name: 'Plerosis', publish: { mode: 'review', inbox: true } } as unknown as ClientProfile;
  const connectionRow = { client_id: 'plerosis', platform: 'github', status: 'connected', label: 'a/b', settings: { repo: 'a/b', installationId: 7 }, last_problem: null };

  /** Answers the connection lookup and the Vault helper. */
  function backend(vaultStatus = 200) {
    const urls: string[] = [];
    const fn = (async (url: string, init: RequestInit = {}) => {
      urls.push(url);
      if (url.includes('/rpc/lodestar_get_secret')) {
        if (vaultStatus !== 200) return { ok: false, status: vaultStatus, text: async () => '' } as Response;
        const name = (JSON.parse(String(init.body)) as { p_name: string }).p_name;
        return { ok: true, status: 200, text: async () => JSON.stringify(name === 'github_app_id' ? '42' : PEM) } as Response;
      }
      return { ok: true, status: 200, text: async () => JSON.stringify([connectionRow]) } as Response;
    }) as unknown as typeof fetch;
    return { fn, urls };
  }

  it('loads the app key before handing back a connector that signs in as the app', async () => {
    const env: Record<string, string | undefined> = { ...HOSTED };
    const b = backend();
    const out = await withConnection(profile, { env, fetch: b.fn });
    expect(out.connector).toMatchObject({ type: 'git', installationId: 7 });
    expect(env.GITHUB_APP_ID).toBe('42');
    expect(env.GITHUB_APP_PRIVATE_KEY).toBe(PEM);
  });

  it('does not touch the Vault for connections that are not the GitHub App', async () => {
    const env: Record<string, string | undefined> = { ...HOSTED };
    const urls: string[] = [];
    const fn = (async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify([{ ...connectionRow, platform: 'webhook', settings: { url: 'https://x.test/h' } }]) } as Response;
    }) as unknown as typeof fetch;
    await withConnection(profile, { env, fetch: fn });
    expect(urls.some((u) => u.includes('lodestar_get_secret'))).toBe(false);
  });

  it('stops a delivery run with a clear message when the key cannot be read', async () => {
    const env: Record<string, string | undefined> = { ...HOSTED };
    await expect(withConnection(profile, { env, fetch: backend(500).fn })).rejects.toThrow(ConnectionError);
    await expect(withConnection(profile, { env, fetch: backend(500).fn })).rejects.toThrow(/a\/b: Could not read the GitHub App key/);
  });

  it('lets a lenient run carry on without the connector so drafts still reach the inbox', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env: Record<string, string | undefined> = { ...HOSTED };
    const out = await withConnection({ ...profile, connector: { type: 'folder', dir: 'x' } } as unknown as ClientProfile, { env, fetch: backend(500).fn, strict: false });
    expect(out.connector).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Drafts will wait in the approval inbox'));
  });
});
