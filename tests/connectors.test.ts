import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createConnector } from '../src/connectors/index.js';
import { GitConnector } from '../src/connectors/git.js';
import { WebhookConnector } from '../src/connectors/webhook.js';
import { WordPressConnector } from '../src/connectors/wordpress.js';
import type { PublishItem } from '../src/connectors/types.js';
import { createHmac } from 'node:crypto';

const item: PublishItem = {
  slug: 'hello',
  title: 'Hello',
  description: 'A description',
  tags: ['a'],
  body: '## Heading\n\nText',
  markdown: '---\ntitle: "Hello"\nstatus: draft\n---\n\n## Heading\n\nText\n',
};
const ctx = (mode: 'review' | 'auto') => ({ clientId: 'c', clientName: 'C', mode });

type Call = { url: string; method: string; body?: any };
function fakeFetch(handler: (c: Call) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    const c: Call = { url, method: init.method ?? 'GET', body: typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body };
    calls.push(c);
    const r = handler(c);
    const status = r.status ?? 200;
    return { ok: status < 300, status, json: async () => r.json ?? {}, text: async () => JSON.stringify(r.json ?? {}) } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('connector config', () => {
  it('rejects raw secrets in config', () => {
    expect(() => createConnector({ type: 'git', repo: 'a/b', token: 'ghp_secret' })).toThrow();
    expect(() => createConnector({ type: 'wordpress', siteUrl: 'https://x.com', userEnv: 'U', passwordEnv: 'P', password: 'hunter2' })).toThrow();
  });
  it('accepts env-name config and applies defaults', () => {
    expect(createConnector({ type: 'git', repo: 'a/b' }).type).toBe('git');
  });
  it('folder connector writes files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'seo-'));
    const c = createConnector({ type: 'folder', dir });
    const [r] = await c.publish([item], ctx('review'));
    expect(r!.ok).toBe(true);
    expect(await readFile(join(dir, 'hello.md'), 'utf8')).toContain('title: "Hello"');
  });
});

describe('git connector', () => {
  const cfg = { type: 'git' as const, repo: 'o/site', baseBranch: 'main', contentDir: 'src/content/blog', tokenEnv: 'T' };
  const handler = (c: Call) => {
    if (c.url.endsWith('/git/ref/heads/main')) return { json: { object: { sha: 'abc' } } };
    if (c.url.endsWith('/git/refs')) return { status: 201 };
    if (c.url.includes('/contents/') && c.method === 'GET') return { status: 404 };
    if (c.url.includes('/contents/') && c.method === 'PUT') return { status: 201 };
    if (c.url.endsWith('/pulls')) return { status: 201, json: { html_url: 'https://github.com/o/site/pull/7', number: 7 } };
    if (c.url.endsWith('/pulls/7/merge')) return { json: { merged: true } };
    return { status: 500 };
  };
  it('opens a PR and leaves it for review', async () => {
    const f = fakeFetch(handler);
    const [r] = await new GitConnector(cfg, { T: 'tok' }, f.fn).publish([item], ctx('review'));
    expect(r!.url).toBe('https://github.com/o/site/pull/7');
    expect(f.calls.some((c) => c.url.endsWith('/merge'))).toBe(false);
    const put = f.calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toContain('src/content/blog/hello.md');
    expect(Buffer.from(put.body.content, 'base64').toString()).toContain('status: published');
    expect(put.body.branch).toMatch(/^seo-engine\//);
  });
  it('merges in auto mode', async () => {
    const f = fakeFetch(handler);
    const [r] = await new GitConnector(cfg, { T: 'tok' }, f.fn).publish([item], ctx('auto'));
    expect(f.calls.some((c) => c.url.endsWith('/pulls/7/merge'))).toBe(true);
    expect(r!.note).toMatch(/Merged/);
  });
  it('skips files that already exist', async () => {
    const f = fakeFetch((c) => (c.url.includes('/contents/') && c.method === 'GET' ? { status: 200 } : handler(c)));
    const out = await new GitConnector(cfg, { T: 'tok' }, f.fn).publish([item], ctx('review'));
    expect(out[0]!.ok).toBe(false);
    expect(f.calls.some((c) => c.url.endsWith('/pulls'))).toBe(false);
  });
  it('check explains a missing token', async () => {
    const p = await new GitConnector(cfg, {}, fakeFetch(() => ({})).fn).check();
    expect(p[0]).toMatch(/Set T/);
  });
});

describe('wordpress connector', () => {
  const cfg = { type: 'wordpress' as const, siteUrl: 'https://wp.example.com/', userEnv: 'U', passwordEnv: 'P' };
  it('saves a draft in review mode and publishes in auto mode', async () => {
    const f = fakeFetch(() => ({ status: 201, json: { link: 'https://wp.example.com/hello' } }));
    const c = new WordPressConnector(cfg, { U: 'u', P: 'p' }, f.fn);
    await c.publish([item], ctx('review'));
    await c.publish([item], ctx('auto'));
    expect(f.calls[0]!.url).toBe('https://wp.example.com/wp-json/wp/v2/posts');
    expect(f.calls[0]!.body.status).toBe('draft');
    expect(f.calls[1]!.body.status).toBe('publish');
    expect(f.calls[0]!.body.content).toContain('<h2>Heading</h2>');
  });
});

describe('webhook connector', () => {
  it('signs the body', async () => {
    const f = fakeFetch(() => ({}));
    let seen: RequestInit | undefined;
    const spy = (async (u: string, init: RequestInit) => {
      seen = init;
      return f.fn(u, init);
    }) as unknown as typeof fetch;
    await new WebhookConnector({ type: 'webhook', url: 'https://hook.example.com', secretEnv: 'S' }, { S: 'shh' }, spy).publish([item], ctx('review'));
    const sig = (seen!.headers as Record<string, string>)['x-seo-engine-signature'];
    expect(sig).toBe(createHmac('sha256', 'shh').update(seen!.body as string).digest('hex'));
  });
  it('requires https', async () => {
    expect((await new WebhookConnector({ type: 'webhook', url: 'http://x.com' }, {}).check())[0]).toMatch(/https/);
  });
});
