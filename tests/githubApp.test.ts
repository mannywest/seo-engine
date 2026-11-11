import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createConnector } from '../src/connectors/index.js';
import { GitConnector } from '../src/connectors/git.js';
import { AppTokenSource, appSettingsProblems, createAppJwt, normalisePrivateKey } from '../src/connectors/githubApp.js';
import type { PublishItem } from '../src/connectors/types.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

type Call = { url: string; method: string; headers: Record<string, string>; body?: any };
function fakeFetch(handler: (c: Call) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    const c: Call = {
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body,
    };
    calls.push(c);
    const r = handler(c);
    const status = r.status ?? 200;
    return { ok: status < 300, status, json: async () => r.json ?? {}, text: async () => JSON.stringify(r.json ?? {}) } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

describe('app sign-in proof (JWT)', () => {
  it('is signed with the app key and carries the app id and a short life', () => {
    const now = Date.UTC(2026, 10, 11, 12, 0, 0);
    const jwt = createAppJwt('12345', privateKey, now);
    const [h, p, s] = jwt.split('.') as [string, string, string];
    expect(decode(h)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decode(p);
    expect(claims.iss).toBe('12345');
    expect(claims.iat).toBe(Math.floor(now / 1000) - 60);
    expect(claims.exp - Math.floor(now / 1000)).toBeLessThanOrEqual(600); // GitHub's maximum
    expect(claims.exp).toBeGreaterThan(Math.floor(now / 1000));
    const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(createPublicKey(publicKey), Buffer.from(s, 'base64url'));
    expect(ok).toBe(true);
  });
  it('accepts a key whose line breaks were flattened to \\n', () => {
    const flat = privateKey.replace(/\n/g, '\\n');
    expect(normalisePrivateKey(flat)).toBe(privateKey.trim());
    expect(() => createAppJwt('1', flat)).not.toThrow();
  });
  it('lists what is missing in plain English', () => {
    expect(appSettingsProblems({})).toHaveLength(2);
    expect(appSettingsProblems({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'k' })).toEqual([]);
    expect(appSettingsProblems({ A: '1' }, 'A', 'B')[0]).toContain('B');
  });
});

describe('short-lived repo key', () => {
  const opts = (fetchFn: typeof fetch, now: () => number) => ({ appId: '9', privateKey, installationId: 777, repo: 'owner/site', fetchFn, now });
  const grant = (expires: string) => (c: Call) => ({ status: 201, json: { token: `tok-${c.headers.authorization?.length}`, expires_at: expires } });

  it('asks GitHub for a key limited to one repo and to only the permissions publishing needs', async () => {
    let t = Date.UTC(2026, 10, 11, 12, 0, 0);
    const f = fakeFetch(grant(new Date(t + 3600_000).toISOString()));
    await new AppTokenSource(opts(f.fn, () => t)).token();
    const call = f.calls[0]!;
    expect(call.url).toBe('https://api.github.com/app/installations/777/access_tokens');
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(call.body).toEqual({ repositories: ['site'], permissions: { contents: 'write', pull_requests: 'write' } });
  });

  it('reuses the key until it is about to expire, then asks again', async () => {
    let t = Date.UTC(2026, 10, 11, 12, 0, 0);
    const f = fakeFetch(grant(new Date(t + 3600_000).toISOString()));
    const src = new AppTokenSource(opts(f.fn, () => t));
    await src.token();
    t += 30 * 60_000;
    await src.token();
    expect(f.calls).toHaveLength(1);
    t += 28 * 60_000; // 58 minutes in: under 5 minutes left
    await src.token();
    expect(f.calls).toHaveLength(2);
  });

  it.each([
    [401, /app id or key is wrong/],
    [404, /no longer installed/],
    [422, /not allowed the engine to use owner\/site/],
    [500, /failed \(500\)/],
  ])('explains a %i answer in plain English', async (status, message) => {
    const f = fakeFetch(() => ({ status }));
    await expect(new AppTokenSource(opts(f.fn, () => Date.now())).token()).rejects.toThrow(message);
  });

  it('never puts the key or the app key into an error message', async () => {
    const f = fakeFetch(() => ({ status: 401 }));
    const err = await new AppTokenSource(opts(f.fn, () => Date.now())).token().catch((e: Error) => e.message);
    expect(err).not.toContain('PRIVATE KEY');
  });
});

describe('git connector signed in as the app', () => {
  const cfg = { type: 'git' as const, repo: 'o/site', baseBranch: 'main', contentDir: 'src/content/blog', tokenEnv: 'NOT_USED', installationId: 55 };
  const env = { GITHUB_APP_ID: '9', GITHUB_APP_PRIVATE_KEY: privateKey };
  const item: PublishItem = { slug: 'hello', title: 'Hello', description: 'd', tags: [], body: 'x', markdown: '---\ntitle: "Hello"\nstatus: draft\n---\n\nx\n' };
  const handler = (c: Call) => {
    if (c.url.endsWith('/access_tokens')) return { status: 201, json: { token: 'app-key-1', expires_at: new Date(Date.now() + 3600_000).toISOString() } };
    if (c.url.endsWith('/git/ref/heads/main')) return { json: { object: { sha: 'abc' } } };
    if (c.url.endsWith('/git/refs')) return { status: 201 };
    if (c.url.includes('/contents/') && c.method === 'GET') return { status: 404 };
    if (c.url.includes('/contents/') && c.method === 'PUT') return { status: 201 };
    if (c.url.endsWith('/pulls')) return { status: 201, json: { html_url: 'https://github.com/o/site/pull/3', number: 3 } };
    return { status: 404 };
  };

  it('publishes a pull request using the minted key, not a pasted token', async () => {
    const f = fakeFetch(handler);
    const [r] = await new GitConnector(cfg, env, f.fn).publish([item], { clientId: 'c', clientName: 'C', mode: 'review' });
    expect(r!.ok).toBe(true);
    expect(r!.url).toBe('https://github.com/o/site/pull/3');
    const repoCalls = f.calls.filter((c) => c.url.startsWith('https://api.github.com/repos/'));
    expect(repoCalls.length).toBeGreaterThan(3);
    for (const c of repoCalls) expect(c.headers.authorization).toBe('Bearer app-key-1');
    expect(f.calls.filter((c) => c.url.endsWith('/access_tokens'))).toHaveLength(1); // one sign-in for the whole publish
  });

  it('check() says what is missing when the app settings are absent', async () => {
    const problems = await new GitConnector(cfg, {}, fakeFetch(handler).fn).check();
    expect(problems.join(' ')).toContain('GITHUB_APP_ID');
    expect(problems.join(' ')).toContain('GITHUB_APP_PRIVATE_KEY');
  });

  it('check() passes without any pasted token when the app is installed and the repo is visible', async () => {
    const f = fakeFetch((c) => (c.url.endsWith('/access_tokens') ? handler(c) : { json: {} }));
    expect(await new GitConnector(cfg, env, f.fn).check()).toEqual([]);
  });

  it('check() reports an app that was uninstalled', async () => {
    const f = fakeFetch(() => ({ status: 404 }));
    const problems = await new GitConnector(cfg, env, f.fn).check();
    expect(problems[0]).toContain('no longer installed');
  });

  it('a client without an installation still uses the token named in its file', async () => {
    const f = fakeFetch(handler);
    const plain = { ...cfg, installationId: undefined, tokenEnv: 'T' };
    await new GitConnector(plain, { T: 'pasted' }, f.fn).publish([item], { clientId: 'c', clientName: 'C', mode: 'review' });
    expect(f.calls.some((c) => c.url.endsWith('/access_tokens'))).toBe(false);
    expect(f.calls[0]!.headers.authorization).toBe('Bearer pasted');
  });
});

describe('connector config for app clients', () => {
  it('accepts an installation id and the names of the app settings', () => {
    expect(createConnector({ type: 'git', repo: 'a/b', installationId: 42, appIdEnv: 'X_ID', privateKeyEnv: 'X_KEY' }).type).toBe('git');
  });
  it('still rejects raw secrets and a bad installation id', () => {
    expect(() => createConnector({ type: 'git', repo: 'a/b', privateKey: '-----BEGIN' })).toThrow();
    expect(() => createConnector({ type: 'git', repo: 'a/b', installationId: 'abc' })).toThrow();
    expect(() => createConnector({ type: 'git', repo: 'a/b', installationId: -1 })).toThrow();
  });
});
