import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import profileJson from '../clients/plerosis.json' with { type: 'json' };
import { FolderConnector } from '../src/connectors/folder.js';
import { GitConnector } from '../src/connectors/git.js';
import { sha256 } from '../src/connectors/hash.js';
import type { Connector, PublishItem, RevertContext } from '../src/connectors/types.js';
import { WebhookConnector } from '../src/connectors/webhook.js';
import { WordPressConnector } from '../src/connectors/wordpress.js';
import { Ledger, recordDelivery, revertChange } from '../src/ledger.js';
import { runPipeline } from '../src/pipeline/run.js';
import { MockProvider, type LlmRequest } from '../src/providers/llm.js';
import { MockSearch } from '../src/providers/search.js';
import type { ClientProfile } from '../src/types.js';

const profile = profileJson as ClientProfile;

const item: PublishItem = {
  slug: 'hello',
  title: 'Hello',
  description: 'A description',
  tags: ['a'],
  body: '## Heading\n\nText',
  markdown: '---\ntitle: "Hello"\nstatus: draft\n---\n\n## Heading\n\nText\n',
};
const publishedMarkdown = item.markdown.replace(/^status: draft$/m, 'status: published');
const review: RevertContext = { mode: 'review', clientName: 'C' };
const auto: RevertContext = { mode: 'auto', clientName: 'C' };
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
const called = (calls: Call[], method: string, part: string) => calls.some((c) => c.method === method && c.url.includes(part));

describe('folder connector undo', () => {
  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const c = new FolderConnector(dir);
    const [r] = await c.publish([item], ctx('review'));
    return { dir, c, handle: r!.handle! };
  }

  it('moves the file aside instead of deleting it', async () => {
    const { dir, c, handle } = await setup();
    const out = await c.revert(handle, review);
    expect(out.ok).toBe(true);
    expect(await readdir(dir)).not.toContain('hello.md');
    const kept = await readdir(join(dir, '.reverted'));
    expect(kept).toHaveLength(1);
    expect(await readFile(join(dir, '.reverted', kept[0]!), 'utf8')).toBe(item.markdown);
    expect((await c.revert(handle, review)).note).toMatch(/already gone/);
  });

  it('refuses when the file was edited since, and keeps the edit if forced', async () => {
    const { dir, c, handle } = await setup();
    await writeFile(join(dir, 'hello.md'), 'My own edit\n', 'utf8');
    const refused = await c.revert(handle, review);
    expect(refused).toMatchObject({ ok: false, refused: true });
    expect(await readFile(join(dir, 'hello.md'), 'utf8')).toBe('My own edit\n');
    const forced = await c.revert(handle, { ...review, force: true });
    expect(forced.ok).toBe(true);
    const kept = await readdir(join(dir, '.reverted'));
    expect(await readFile(join(dir, '.reverted', kept[0]!), 'utf8')).toBe('My own edit\n');
  });

  it('restores what was there before when the delivery replaced a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
    await writeFile(join(dir, 'hello.md'), 'Older version\n', 'utf8');
    const c = new FolderConnector(dir);
    const [r] = await c.publish([item], ctx('review'));
    expect((await c.revert(r!.handle!, review)).note).toMatch(/Restored the previous version/);
    expect(await readFile(join(dir, 'hello.md'), 'utf8')).toBe('Older version\n');
    const kept = await readdir(join(dir, '.reverted'));
    expect(await readFile(join(dir, '.reverted', kept[0]!), 'utf8')).toBe(item.markdown);
  });
});

describe('wordpress connector undo', () => {
  const cfg = { type: 'wordpress' as const, siteUrl: 'https://x.com', userEnv: 'U', passwordEnv: 'P' };
  const env = { U: 'u', P: 'p' };
  const wp = (editedAt: string | 'missing' | 'trash') =>
    fakeFetch((c) => {
      if (c.method === 'POST') return { status: 201, json: { id: 12, link: 'https://x.com/hello', modified_gmt: 'T1' } };
      if (c.method === 'GET') {
        if (editedAt === 'missing') return { status: 404 };
        return { json: { status: editedAt === 'trash' ? 'trash' : 'draft', modified_gmt: editedAt === 'trash' ? 'T1' : editedAt } };
      }
      if (c.method === 'DELETE') return { json: { deleted: false } };
      return { status: 500 };
    });

  async function publish(f: ReturnType<typeof wp>) {
    const c = new WordPressConnector(cfg, env, f.fn);
    const [r] = await c.publish([item], ctx('review'));
    return { c, handle: r!.handle! };
  }

  it('remembers the post and sends it to the trash, not erasing it', async () => {
    const f = wp('T1');
    const { c, handle } = await publish(f);
    expect(handle).toEqual({ postId: 12, modifiedGmt: 'T1' });
    const out = await c.revert(handle, review);
    expect(out).toMatchObject({ ok: true });
    expect(out.note).toMatch(/trash/);
    const del = f.calls.find((x) => x.method === 'DELETE')!;
    expect(del.url).toMatch(/\/posts\/12$/);
    expect(del.url).not.toMatch(/force/);
  });

  it('refuses when the post was edited in WordPress since, unless forced', async () => {
    const f = wp('T2');
    const { c, handle } = await publish(f);
    expect(await c.revert(handle, review)).toMatchObject({ ok: false, refused: true });
    expect(called(f.calls, 'DELETE', '/posts/')).toBe(false);
    expect((await c.revert(handle, { ...review, force: true })).ok).toBe(true);
    expect(called(f.calls, 'DELETE', '/posts/12')).toBe(true);
  });

  it('treats a missing or already-trashed post as done', async () => {
    for (const state of ['missing', 'trash'] as const) {
      const f = wp(state);
      const { c, handle } = await publish(f);
      const out = await c.revert(handle, review);
      expect(out.ok).toBe(true);
      expect(called(f.calls, 'DELETE', '/posts/')).toBe(false);
    }
  });

  it('reports a failed trash call instead of claiming success', async () => {
    const f = fakeFetch((c) => (c.method === 'POST' ? { status: 201, json: { id: 12, modified_gmt: 'T1' } } : c.method === 'GET' ? { json: { status: 'draft', modified_gmt: 'T1' } } : { status: 500 }));
    const { c, handle } = await publish(f as ReturnType<typeof wp>);
    await expect(c.revert(handle, review)).rejects.toThrow(/500/);
  });
});

describe('git connector undo', () => {
  const cfg = { type: 'git' as const, repo: 'o/site', baseBranch: 'main', contentDir: 'src/content/blog', tokenEnv: 'T' };
  const path = 'src/content/blog/hello.md';
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

  /** A fake GitHub whose state the test controls. */
  function github(state: { pr: { state: string; merged: boolean } | 'unreadable'; file: string | null; openPrs?: { title: string; html_url: string }[] }) {
    return fakeFetch((c) => {
      const u = c.url.replace('https://api.github.com/repos/o/site', '');
      if (u === '/git/ref/heads/main') return { json: { object: { sha: 'abc' } } };
      if (u === '/git/refs' && c.method === 'POST') return { status: 201 };
      if (u.startsWith('/git/refs/heads/') && c.method === 'DELETE') return { status: 204 };
      if (u.startsWith('/contents/') && c.method === 'GET') {
        if (state.file === null) return { status: 404 };
        return { json: { sha: 'blob1', content: b64(state.file) } };
      }
      if (u.startsWith('/contents/') && c.method === 'PUT') return { status: 201 };
      if (u.startsWith('/contents/') && c.method === 'DELETE') return { status: 200 };
      if (u === '/pulls' && c.method === 'POST') return { status: 201, json: { html_url: c.body.title.startsWith('Undo') ? 'https://github.com/o/site/pull/8' : 'https://github.com/o/site/pull/7', number: c.body.title.startsWith('Undo') ? 8 : 7 } };
      if (u.startsWith('/pulls?state=open')) return { json: state.openPrs ?? [] };
      if (u === '/pulls/7' && c.method === 'GET') return state.pr === 'unreadable' ? { status: 500 } : { json: state.pr };
      if (u === '/pulls/7' && c.method === 'PATCH') return { json: { state: 'closed' } };
      if (u === '/pulls/8/merge') return { json: { merged: true } };
      if (u === '/pulls/7/merge') return { json: { merged: true } };
      return { status: 500 };
    });
  }
  async function delivered(f: ReturnType<typeof github>) {
    const c = new GitConnector(cfg, { T: 'tok' }, f.fn);
    // Publishing needs "file does not exist yet" on the base branch, so use a separate fake for that step.
    const pub = fakeFetch((x) => {
      if (x.url.endsWith('/git/ref/heads/main')) return { json: { object: { sha: 'abc' } } };
      if (x.url.endsWith('/git/refs')) return { status: 201 };
      if (x.url.includes('/contents/') && x.method === 'GET') return { status: 404 };
      if (x.url.includes('/contents/') && x.method === 'PUT') return { status: 201 };
      if (x.url.endsWith('/pulls')) return { status: 201, json: { html_url: 'https://github.com/o/site/pull/7', number: 7 } };
      return { status: 500 };
    });
    const [r] = await new GitConnector(cfg, { T: 'tok' }, pub.fn).publish([item], ctx('review'));
    return { c, handle: r!.handle! };
  }

  it('remembers the pull request, branch, file and a fingerprint', async () => {
    const { handle } = await delivered(github({ pr: { state: 'open', merged: false }, file: null }));
    expect(handle).toMatchObject({ prNumber: 7, path, sha256: sha256(publishedMarkdown) });
    expect(String(handle.branch)).toMatch(/^seo-engine\//);
  });

  it('closes a pull request that was never merged and removes its branch', async () => {
    const f = github({ pr: { state: 'open', merged: false }, file: null });
    const { c, handle } = await delivered(f);
    const out = await c.revert(handle, review);
    expect(out).toMatchObject({ ok: true });
    expect(out.note).toMatch(/Closed pull request #7/);
    expect(f.calls.find((x) => x.method === 'PATCH')?.body).toEqual({ state: 'closed' });
    expect(called(f.calls, 'DELETE', '/git/refs/heads/seo-engine/')).toBe(true);
  });

  it('does nothing to a pull request that was already closed without merging', async () => {
    const f = github({ pr: { state: 'closed', merged: false }, file: null });
    const { c, handle } = await delivered(f);
    expect((await c.revert(handle, review)).ok).toBe(true);
    expect(called(f.calls, 'PATCH', '/pulls/7')).toBe(false);
  });

  it('opens a pull request that removes a merged article, and leaves it for approval in review mode', async () => {
    const f = github({ pr: { state: 'closed', merged: true }, file: publishedMarkdown });
    const { c, handle } = await delivered(f);
    const out = await c.revert(handle, review);
    expect(out).toMatchObject({ ok: true, pending: true, url: 'https://github.com/o/site/pull/8' });
    const del = f.calls.find((x) => x.method === 'DELETE' && x.url.includes('/contents/'))!;
    expect(del.body).toMatchObject({ sha: 'blob1' });
    expect(del.body.branch).toMatch(/^seo-engine\/revert-/);
    expect(called(f.calls, 'PUT', '/merge')).toBe(false);
  });

  it('merges the removal straight away in auto mode', async () => {
    const f = github({ pr: { state: 'closed', merged: true }, file: publishedMarkdown });
    const { c, handle } = await delivered(f);
    const out = await c.revert(handle, auto);
    expect(out.ok).toBe(true);
    expect(out.pending).toBeUndefined();
    expect(called(f.calls, 'PUT', '/pulls/8/merge')).toBe(true);
  });

  it('refuses when the live file was changed since, unless forced', async () => {
    const f = github({ pr: { state: 'closed', merged: true }, file: `${publishedMarkdown}\nAn extra paragraph someone added.\n` });
    const { c, handle } = await delivered(f);
    expect(await c.revert(handle, review)).toMatchObject({ ok: false, refused: true });
    expect(called(f.calls, 'DELETE', '/contents/')).toBe(false);
    expect((await c.revert(handle, { ...review, force: true })).ok).toBe(true);
  });

  it('treats an article that is already gone as done', async () => {
    const f = github({ pr: { state: 'closed', merged: true }, file: null });
    const { c, handle } = await delivered(f);
    expect((await c.revert(handle, review)).note).toMatch(/already gone/);
  });

  it('does not open a second undo pull request when one is already open', async () => {
    const f = github({ pr: { state: 'closed', merged: true }, file: publishedMarkdown, openPrs: [{ title: 'Undo: remove hello.md (from #7)', html_url: 'https://github.com/o/site/pull/8' }] });
    const { c, handle } = await delivered(f);
    const out = await c.revert(handle, review);
    expect(out).toMatchObject({ ok: true, pending: true, url: 'https://github.com/o/site/pull/8' });
    expect(called(f.calls, 'POST', '/git/refs')).toBe(false);
  });

  it('reports an unreadable pull request as an error instead of guessing', async () => {
    const f = github({ pr: 'unreadable', file: null });
    const { c, handle } = await delivered(f);
    await expect(c.revert(handle, review)).rejects.toThrow(/Could not read pull request #7/);
  });

  describe('through the ledger, an undo that needs approval is settled once approved', () => {
    it('updates the same undo entry instead of adding another', async () => {
      const state: Parameters<typeof github>[0] = { pr: { state: 'closed', merged: true }, file: publishedMarkdown };
      const f = github(state);
      const { c, handle } = await delivered(f);
      const ledger = new Ledger([], 'unused');
      const entry = recordDelivery(ledger, c, item, { slug: 'hello', ok: true, handle, url: 'https://github.com/o/site/pull/7' }, { mode: 'review' });

      const first = await revertChange(ledger, entry.id, c, review);
      expect(first).toMatchObject({ ok: true, pending: true });
      expect(ledger.get(entry.id)?.status).toBe('revert_pending');
      expect(ledger.entries).toHaveLength(2);

      state.file = null; // the undo pull request has been merged, so the article is gone
      const second = await revertChange(ledger, entry.id, c, review);
      expect(second.ok).toBe(true);
      expect(second.pending).toBeUndefined();
      expect(ledger.get(entry.id)?.status).toBe('reverted');
      expect(ledger.entries).toHaveLength(2);
      expect(ledger.get(ledger.get(entry.id)!.revertedBy!)?.status).toBe('applied');
    });
  });
});

describe('webhook deliveries', () => {
  it('are recorded as not undoable from here, with the reason', async () => {
    const f = fakeFetch(() => ({ status: 200 }));
    const c = new WebhookConnector({ type: 'webhook', url: 'https://hook.test/x' }, {}, f.fn);
    const [r] = await c.publish([item], ctx('auto'));
    expect(r!.handle).toBeUndefined();
    const ledger = new Ledger([], 'unused');
    const entry = recordDelivery(ledger, c, item, r!, { mode: 'auto' });
    expect(entry.reversible).toBe(false);
    const out = await revertChange(ledger, entry.id, c, auto);
    expect(out).toMatchObject({ ok: false, refused: true });
    expect(out.message).toMatch(/another system/);
  });
});

describe('ledger and revertChange', () => {
  it('treats a missing file as empty, round-trips, and refuses an invalid file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const empty = await Ledger.load('acme', dir);
    expect(empty.entries).toEqual([]);
    empty.add({ at: 'x', kind: 'publish', slug: 's', title: 'T', connector: 'folder', summary: 'x', reversible: false, status: 'applied' }, new Date('2026-11-10T13:00:00Z'));
    await empty.save();
    expect((await Ledger.load('acme', dir)).entries[0]?.id).toBe('20261110T130000-s');
    await mkdir(join(dir, 'bad'), { recursive: true });
    await writeFile(join(dir, 'bad', 'ledger.json'), JSON.stringify([{ id: 'x' }]));
    await expect(Ledger.load('bad', dir)).rejects.toThrow(/not a valid change ledger/);
  });

  it('gives every entry its own id, even for the same article in the same second', () => {
    const l = new Ledger([], 'unused');
    const e = { at: 'x', kind: 'publish' as const, slug: 's', title: 'T', connector: 'folder', summary: 'x', reversible: false, status: 'applied' as const };
    const now = new Date('2026-11-10T13:00:00Z');
    expect(new Set([l.add(e, now).id, l.add(e, now).id, l.add(e, now).id]).size).toBe(3);
  });

  async function withFolder() {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const c = new FolderConnector(dir);
    const [r] = await c.publish([item], ctx('review'));
    const ledger = new Ledger([], 'unused');
    const entry = recordDelivery(ledger, c, item, r!, { mode: 'review' });
    return { dir, c, ledger, entry };
  }

  it('undoes a change, records the undo, and is safe to ask twice', async () => {
    const { dir, c, ledger, entry } = await withFolder();
    expect(entry).toMatchObject({ reversible: true, status: 'applied', connector: 'folder' });
    const out = await revertChange(ledger, entry.id, c, review);
    expect(out.ok).toBe(true);
    expect(await readdir(dir)).not.toContain('hello.md');
    expect(ledger.get(entry.id)?.status).toBe('reverted');
    const undo = ledger.get(ledger.get(entry.id)!.revertedBy!)!;
    expect(undo).toMatchObject({ kind: 'revert', reverts: entry.id, status: 'applied' });
    expect((await revertChange(ledger, entry.id, c, review)).message).toMatch(/Already undone/);
    expect(ledger.entries).toHaveLength(2);
    expect(await revertChange(ledger, undo.id, c, review)).toMatchObject({ ok: false, refused: true });
  });

  it('changes nothing when the page was edited since', async () => {
    const { dir, c, ledger, entry } = await withFolder();
    await writeFile(join(dir, 'hello.md'), 'Edited by the owner\n', 'utf8');
    const out = await revertChange(ledger, entry.id, c, review);
    expect(out).toMatchObject({ ok: false, refused: true });
    expect(ledger.get(entry.id)?.status).toBe('applied');
    expect(ledger.entries).toHaveLength(1);
    expect(await readFile(join(dir, 'hello.md'), 'utf8')).toBe('Edited by the owner\n');
  });

  it('refuses an unknown id, a missing connector and a different connector', async () => {
    const { c, ledger, entry } = await withFolder();
    expect((await revertChange(ledger, 'nope', c, review)).message).toMatch(/no change with the id/);
    expect((await revertChange(ledger, entry.id, undefined, review)).refused).toBe(true);
    const wp = new WordPressConnector({ type: 'wordpress', siteUrl: 'https://x.com', userEnv: 'U', passwordEnv: 'P' }, { U: 'u', P: 'p' }, fakeFetch(() => ({})).fn);
    expect((await revertChange(ledger, entry.id, wp, review)).message).toMatch(/made through folder/);
    expect(ledger.get(entry.id)?.status).toBe('applied');
  });

  it('marks a failed undo and allows a retry', async () => {
    const { c, ledger, entry } = await withFolder();
    let fail = true;
    const flaky: Connector = {
      type: 'folder',
      check: async () => [],
      publish: async () => [],
      revert: async (h, x) => {
        if (fail) throw new Error('disk is full');
        return c.revert(h, x);
      },
    };
    const first = await revertChange(ledger, entry.id, flaky, review);
    expect(first.ok).toBe(false);
    expect(first.message).toMatch(/disk is full/);
    expect(ledger.get(entry.id)?.status).toBe('revert_failed');
    fail = false;
    expect((await revertChange(ledger, entry.id, flaky, review)).ok).toBe(true);
    expect(ledger.get(entry.id)?.status).toBe('reverted');
  });
});

describe('ledger in the pipeline', () => {
  it('records each delivery that goes through, and the delivery can then be undone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const site = join(dir, 'site');
    const filler = 'word '.repeat(300);
    const body = [`Direct answer paragraph. ${filler}`, '## First section', `See [what we do](/what-we-do). ${filler}`, '## Second section', `Read [how we work](/how-we-work). ${filler}`, '## Third section', filler, '## Frequently asked questions', '**Question?** Answer.'].join('\n\n');
    const mock = new MockProvider();
    const llm = {
      name: 'fake',
      complete: async (r: LlmRequest) =>
        r.task === 'plan' ? mock.complete(r) : JSON.stringify({ title: 'A good title', description: 'A meta description that is comfortably between seventy and one hundred and sixty characters long.', body, tags: [] }),
    };
    const connector = new FolderConnector(site);
    const ledger = new Ledger([], 'unused');
    const [result] = await runPipeline(profile, llm, new MockSearch(), { count: 1, outDir: join(dir, 'out'), mock: false, connector, ledger });
    expect(result?.quality.passed).toBe(true);
    expect(result?.deliveredTo).toBeDefined();
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ kind: 'publish', connector: 'folder', reversible: true, status: 'applied' });
    expect(await readdir(site)).toContain(`${result!.slug}.md`);

    const out = await revertChange(ledger, ledger.entries[0]!.id, connector, review);
    expect(out.ok).toBe(true);
    expect(await readdir(site)).not.toContain(`${result!.slug}.md`);
  });

  it('records nothing when no connector is set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const ledger = new Ledger([], 'unused');
    await runPipeline(profile, new MockProvider(), new MockSearch(), { count: 1, outDir: join(dir, 'out'), mock: true, ledger });
    expect(ledger.entries).toEqual([]);
  });
});
