import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import profileJson from '../clients/plerosis.json' with { type: 'json' };
import type { Connector, PublishContext, PublishItem } from '../src/connectors/types.js';
import { decide, FileInboxStore, InboxError, itemFromDraft, publishApproved, type InboxItem } from '../src/inbox.js';
import { Ledger } from '../src/ledger.js';
import { runPipeline } from '../src/pipeline/run.js';
import type { ClientProfile, Draft } from '../src/types.js';

const profile = profileJson as ClientProfile;
const tmp = () => mkdtemp(join(tmpdir(), 'inbox-'));

const quality = { passed: true, score: 91, issues: [], warnings: ['No outbound links to sources.'] };
const draftFor = (slug: string): Draft => ({
  topic: { title: `Topic ${slug}`, slug, keyword: 'kw', intent: 'info', outline: ['a', 'b', 'c'] },
  title: `Title ${slug}`,
  description: 'd'.repeat(80),
  body: `Original text for ${slug}.\n\n## One\n\nMore.`,
  tags: ['x'],
  sources: [{ title: 'S', url: 'https://example.com/s', snippet: 'full snippet text' }],
});
const waiting = (slug: string): InboxItem => itemFromDraft(draftFor(slug), quality, { status: 'waiting', reason: 'Ready for your approval.' });

interface Call { item: PublishItem; ctx: PublishContext }
function fakeConnector(behaviour: (n: number) => 'ok' | 'throw' | 'refuse' = () => 'ok') {
  const calls: Call[] = [];
  const c: Connector = {
    type: 'fake',
    check: async () => [],
    publish: async (items, ctx) => {
      const mode = behaviour(calls.length);
      calls.push({ item: items[0]!, ctx });
      if (mode === 'throw') throw new Error('site is down');
      if (mode === 'refuse') return [{ slug: items[0]!.slug, ok: false, note: 'Rejected by the site.' }];
      return [{ slug: items[0]!.slug, ok: true, url: `https://site.example/${items[0]!.slug}`, handle: { n: calls.length } }];
    },
    revert: async () => ({ ok: true, note: 'undone' }),
  };
  return { c, calls };
}

describe('inbox file store', () => {
  it('keeps items between runs and replaces an item with the same id', async () => {
    const dir = await tmp();
    const a = await FileInboxStore.load('c1', dir);
    await a.put(waiting('one'));
    await a.put({ ...waiting('one'), reason: 'changed' });
    await a.put(waiting('two'));
    const b = await FileInboxStore.load('c1', dir);
    expect((await b.list()).map((i) => i.id)).toEqual(['one', 'two']);
    expect((await b.get('one'))?.reason).toBe('changed');
  });
  it('an empty inbox is fine, a broken file is an error', async () => {
    const dir = await tmp();
    expect(await (await FileInboxStore.load('none', dir)).list()).toEqual([]);
    const s = await FileInboxStore.load('bad', dir);
    await s.put(waiting('x'));
    await writeFile(join(dir, 'bad', 'inbox.json'), '[{"id":"x"}]');
    await expect(FileInboxStore.load('bad', dir)).rejects.toThrow(/not a valid approval inbox/);
  });
});

describe('deciding', () => {
  it('approves and records who and when', async () => {
    const s = await FileInboxStore.load('c', await tmp());
    await s.put(waiting('a'));
    const r = await decide(s, 'a', 'approve', { by: 'manny', note: 'looks good', now: new Date('2026-11-11T12:00:00Z') });
    expect(r).toMatchObject({ status: 'approved', decidedBy: 'manny', decidedAt: '2026-11-11T12:00:00.000Z', note: 'looks good' });
    expect((await s.get('a'))?.status).toBe('approved');
  });
  it('an edit replaces the text and is marked as edited', async () => {
    const s = await FileInboxStore.load('c', await tmp());
    await s.put(waiting('a'));
    const r = await decide(s, 'a', 'approve', { by: 'm', editedBody: 'Corrected text.' });
    expect(r.body).toBe('Corrected text.');
    expect(r.edited).toBe(true);
  });
  it('refuses empty edits, unknown ids, and anything already published', async () => {
    const s = await FileInboxStore.load('c', await tmp());
    await s.put(waiting('a'));
    await expect(decide(s, 'a', 'approve', { by: 'm', editedBody: '   ' })).rejects.toThrow(InboxError);
    expect((await s.get('a'))?.status).toBe('waiting');
    await expect(decide(s, 'nope', 'approve', { by: 'm' })).rejects.toThrow(/nothing in the inbox/);
    await s.put({ ...waiting('p'), status: 'published' });
    await expect(decide(s, 'p', 'reject', { by: 'm' })).rejects.toThrow(/already published/);
  });
  it('rejecting keeps the article but never publishes it', async () => {
    const s = await FileInboxStore.load('c', await tmp());
    await s.put(waiting('a'));
    await decide(s, 'a', 'reject', { by: 'm', note: 'off brand' });
    const { c, calls } = fakeConnector();
    expect(await publishApproved(s, profile, c)).toEqual([]);
    expect(calls).toHaveLength(0);
    expect((await s.get('a'))?.status).toBe('rejected');
  });
});

describe('publishing approved articles', () => {
  it('publishes only approved items, live, with the edited text, and records it in the ledger', async () => {
    const s = await FileInboxStore.load('c', await tmp());
    await s.put(waiting('ok'));
    await s.put(waiting('later'));
    await decide(s, 'ok', 'approve', { by: 'm', editedBody: 'Edited body text.\n\n## One\n\nMore.' });
    const ledger = await Ledger.load('c', await tmp());
    const { c, calls } = fakeConnector();
    const res = await publishApproved(s, { ...profile, publish: { ...profile.publish, mode: 'review' } }, c, ledger);
    expect(res).toEqual([{ id: 'ok', ok: true, note: 'Published.', url: 'https://site.example/ok' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ctx.mode).toBe('auto');
    expect(calls[0]!.item.body).toContain('Edited body text.');
    expect(calls[0]!.item.markdown).toContain('status: published');
    const done = await s.get('ok');
    expect(done).toMatchObject({ status: 'published', deliveredTo: 'https://site.example/ok' });
    expect(ledger.entries).toHaveLength(1);
    expect(done?.ledgerId).toBe(ledger.entries[0]!.id);
    expect((await s.get('later'))?.status).toBe('waiting');
  });
  it('does not publish the same article twice', async () => {
    const s = await FileInboxStore.load('c', await tmp());
    await s.put(waiting('a'));
    await decide(s, 'a', 'approve', { by: 'm' });
    const { c, calls } = fakeConnector();
    await publishApproved(s, profile, c);
    await publishApproved(s, profile, c);
    expect(calls).toHaveLength(1);
  });
  it('a failed delivery keeps the article and the next run tries again', async () => {
    const s = await FileInboxStore.load('c', await tmp());
    await s.put(waiting('a'));
    await decide(s, 'a', 'approve', { by: 'm' });
    const f = fakeConnector((n) => (n === 0 ? 'throw' : 'ok'));
    const first = await publishApproved(s, profile, f.c);
    expect(first[0]).toMatchObject({ ok: false });
    expect(first[0]!.note).toContain('site is down');
    expect((await s.get('a'))?.status).toBe('publish_failed');
    const second = await publishApproved(s, profile, f.c);
    expect(second[0]!.ok).toBe(true);
    expect((await s.get('a'))?.status).toBe('published');
  });
  it('a refusal from the site is treated as a failure, not success', async () => {
    const s = await FileInboxStore.load('c', await tmp());
    await s.put(waiting('a'));
    await decide(s, 'a', 'approve', { by: 'm' });
    const { c } = fakeConnector(() => 'refuse');
    const [r] = await publishApproved(s, profile, c);
    expect(r).toMatchObject({ ok: false, note: 'Rejected by the site.' });
    expect((await s.get('a'))?.status).toBe('publish_failed');
  });
  it('can be approved after a failure with a fix', async () => {
    const s = await FileInboxStore.load('c', await tmp());
    await s.put({ ...waiting('a'), status: 'publish_failed' });
    const r = await decide(s, 'a', 'approve', { by: 'm', editedBody: 'Fixed text here.' });
    expect(r.body).toBe('Fixed text here.');
  });
});

describe('the inbox inside a live run', () => {
  const filler = 'Plain words about the fresh topic we cover for small firms every single day. '.repeat(24);
  const goodBody = [`Direct answer about the fresh topic. ${filler}`, '## First', `See [what we do](/what-we-do). ${filler}`, '## Second', `Read [how we work](/how-we-work). ${filler}`, '## Third', filler, '## Frequently asked questions', '**Question?** Answer.'].join('\n\n');
  const badBody = goodBody + ' We let software take the standard 80% of the work.';
  const topicJson = JSON.stringify({ topics: [{ title: 'A fresh topic title', keyword: 'fresh topic', intent: 'info', outline: ['a', 'b', 'c'] }] });
  const source = { name: 'fake', search: async () => [{ title: 'S', url: 'https://example.com/s', snippet: 'plain words fresh topic', fullText: 'plain words about the fresh topic we cover' }] };
  const draftJson = (b: string) => JSON.stringify({ title: 'A fresh topic title here', description: 'A description about the fresh topic that sits comfortably between seventy and one hundred sixty characters.', body: b, tags: [] });
  const llmFor = (draftBodies: string[]) => ({
    name: 'fake',
    complete: async (r: { task: string; system: string }) => {
      if (r.system.includes('careful editor')) return JSON.stringify({ body: badBody }); // a repair that does not help
      if (r.task === 'plan') return topicJson;
      return draftJson(draftBodies.shift() ?? goodBody);
    },
  });
  const run = async (mode: 'review' | 'auto', body: string, o: { mock?: boolean; withInbox?: boolean } = {}) => {
    const dir = await tmp();
    const inbox = await FileInboxStore.load('c', dir);
    const { c, calls } = fakeConnector();
    const p: ClientProfile = { ...profile, minInternalLinks: 2, publish: { ...profile.publish, mode } };
    const [res] = await runPipeline(p, llmFor([body]), source, { count: 1, outDir: join(dir, 'out'), mock: !!o.mock, connector: c, ...(o.withInbox === false ? {} : { inbox }) });
    return { res: res!, inbox, calls };
  };

  it('the good draft really passes the automatic checks', async () => {
    const { res } = await run('auto', goodBody, { withInbox: false });
    expect(res.quality.issues).toEqual([]);
  });
  it('review mode: a passing draft waits for approval and is not delivered', async () => {
    const { res, inbox, calls } = await run('review', goodBody);
    expect(calls).toHaveLength(0);
    expect(res.waitingForApproval).toBe(true);
    const [item] = await inbox.list();
    expect(item).toMatchObject({ status: 'waiting', reason: 'Ready for your approval.' });
    expect(item!.quality.passed).toBe(true);
  });
  it('auto mode: a passing draft is delivered and shown in the inbox as published', async () => {
    const { res, inbox, calls } = await run('auto', goodBody);
    expect(calls).toHaveLength(1);
    expect(res.waitingForApproval).toBeUndefined();
    expect((await inbox.list())[0]).toMatchObject({ status: 'published' });
  });
  it('auto mode: a draft that fails the checks waits instead of being delivered', async () => {
    const { res, inbox, calls } = await run('auto', badBody);
    expect(calls).toHaveLength(0);
    expect(res.quality.passed).toBe(false);
    const [item] = await inbox.list();
    expect(item!.status).toBe('waiting');
    expect(item!.reason).toMatch(/Needs a look first/);
    expect(item!.quality.issues.join()).toContain('80%');
  });
  it('practice (mock) runs never touch the inbox', async () => {
    const { inbox } = await run('review', goodBody, { mock: true });
    expect(await inbox.list()).toEqual([]);
  });
  it('without an inbox, delivery works as before', async () => {
    const { calls, res } = await run('auto', goodBody, { withInbox: false });
    expect(calls).toHaveLength(1);
    expect(res.deliveredTo).toBeDefined();
  });
  it('the whole journey: waits, is approved, then publishes and can be found in the ledger', async () => {
    const { inbox } = await run('review', goodBody);
    const id = (await inbox.list())[0]!.id;
    await decide(inbox, id, 'approve', { by: 'manny' });
    const ledger = await Ledger.load('c', await tmp());
    const { c, calls } = fakeConnector();
    const out = await publishApproved(inbox, { ...profile, publish: { ...profile.publish, mode: 'review' } }, c, ledger);
    expect(out[0]!.ok).toBe(true);
    expect(calls[0]!.item.markdown).toContain('status: published');
    expect(ledger.entries[0]!.slug).toBe(id);
  });
});
