import { describe, expect, it } from 'vitest';
import profileJson from '../clients/plerosis.json' with { type: 'json' };
import type { Connector, PublishItem } from '../src/connectors/types.js';
import { decide, itemFromDraft, publishApproved, type InboxItem } from '../src/inbox.js';
import { fromRow, SupabaseError, SupabaseInboxStore, toRow } from '../src/inboxSupabase.js';
import type { ClientProfile, Draft } from '../src/types.js';

const profile = profileJson as ClientProfile;
const URL_ = 'https://abcd1234.supabase.co';
const KEY = 'service-key-for-tests';

const COLUMNS = [
  'client_id', 'id', 'added_at', 'status', 'reason', 'title', 'description', 'tags', 'body', 'topic', 'sources', 'quality',
  'decided_at', 'decided_by', 'note', 'edited', 'delivered_to', 'delivery_note', 'ledger_id',
].sort();

interface Seen { method: string; url: URL; headers: Record<string, string>; body?: unknown }

/** A pretend Supabase: one in-memory table that answers the same web requests the real one does. */
function fakeSupabase(opts: { failWith?: number } = {}) {
  const rows: Record<string, unknown>[] = [];
  const seen: Seen[] = [];
  const pgTime = (v: unknown) => (typeof v === 'string' ? v.replace('Z', '+00:00') : v); // like Postgres timestamptz
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method, url, headers, body });
    if (opts.failWith) return new Response('{"message":"boom"}', { status: opts.failWith });
    if (headers.apikey !== KEY || headers.Authorization !== `Bearer ${KEY}`) return new Response('{"message":"bad key"}', { status: 401 });
    if (!url.pathname.endsWith('/rest/v1/inbox_items')) return new Response('{"message":"no such table"}', { status: 404 });

    if (method === 'GET') {
      let out = rows.slice();
      const cid = url.searchParams.get('client_id');
      if (cid?.startsWith('eq.')) out = out.filter((r) => r.client_id === cid.slice(3));
      const id = url.searchParams.get('id');
      if (id?.startsWith('eq.')) out = out.filter((r) => r.id === id.slice(3));
      out.sort((a, b) => String(a.added_at).localeCompare(String(b.added_at)) || String(a.id).localeCompare(String(b.id)));
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 1000);
      return new Response(JSON.stringify(out.slice(offset, offset + limit).map((r) => ({ ...r, added_at: pgTime(r.added_at), decided_at: pgTime(r.decided_at) }))), { status: 200 });
    }
    if (method === 'POST') {
      if (url.searchParams.get('on_conflict') !== 'client_id,id') return new Response('{"message":"needs on_conflict"}', { status: 409 });
      if (!String(headers.Prefer).includes('resolution=merge-duplicates')) return new Response('{"message":"duplicate key"}', { status: 409 });
      for (const row of body as Record<string, unknown>[]) {
        if (Object.keys(row).sort().join() !== COLUMNS.join()) return new Response('{"message":"all columns must be sent"}', { status: 400 });
        const n = rows.findIndex((r) => r.client_id === row.client_id && r.id === row.id);
        if (n === -1) rows.push(row);
        else rows[n] = row; // every column was sent, so this is a full replace
      }
      return new Response(null, { status: 201 });
    }
    return new Response('{}', { status: 405 });
  }) as typeof fetch;
  return { f, rows, seen };
}

const quality = { passed: true, score: 91, issues: [], warnings: ['No outbound links to sources.'] };
const draftFor = (slug: string): Draft => ({
  topic: { title: `Topic ${slug}`, slug, keyword: 'kw', intent: 'info', outline: ['a', 'b', 'c'] },
  title: `Title ${slug}`,
  description: 'd'.repeat(80),
  body: `Original text for ${slug}.\n\n## One\n\nMore.`,
  tags: ['x'],
  sources: [{ title: 'S', url: 'https://example.com/s', snippet: 'full snippet text' }],
});
const waiting = (slug: string, now = new Date('2026-11-11T10:00:00.000Z')): InboxItem =>
  itemFromDraft(draftFor(slug), quality, { status: 'waiting', reason: 'Ready for your approval.', now });
const store = (fake: ReturnType<typeof fakeSupabase>, clientId = 'c1') =>
  new SupabaseInboxStore({ url: URL_, key: KEY, clientId, fetch: fake.f });

describe('supabase inbox store', () => {
  it('an empty inbox is fine', async () => {
    const s = store(fakeSupabase());
    expect(await s.list()).toEqual([]);
    expect(await s.get('nope')).toBeUndefined();
  });

  it('keeps an item exactly as it was saved, including every optional field', async () => {
    const s = store(fakeSupabase());
    const full: InboxItem = {
      ...waiting('a'),
      status: 'published',
      decidedAt: '2026-11-11T12:00:00.000Z',
      decidedBy: 'manny@example.com',
      note: 'looks good',
      edited: true,
      deliveredTo: 'https://site.example/a',
      deliveryNote: 'ok',
      ledgerId: 'led-1',
    };
    await s.put(full);
    expect(await s.get('a')).toStrictEqual(full);
    expect(await s.list()).toStrictEqual([full]);
  });

  it('an item with no optional fields comes back with none (no nulls leak out)', async () => {
    const s = store(fakeSupabase());
    const plain = waiting('a');
    await s.put(plain);
    expect(await s.get('a')).toStrictEqual(plain);
  });

  it('saving the same id replaces the item completely, clearing fields that are no longer set', async () => {
    const s = store(fakeSupabase());
    await s.put({ ...waiting('a'), status: 'publish_failed', deliveryNote: 'site is down' });
    await s.put({ ...waiting('a'), status: 'published', deliveredTo: 'https://site.example/a' });
    const got = await s.get('a');
    expect(got?.status).toBe('published');
    expect(got).not.toHaveProperty('deliveryNote');
    expect(await s.list()).toHaveLength(1);
  });

  it('lists oldest first', async () => {
    const s = store(fakeSupabase());
    await s.put(waiting('late', new Date('2026-11-11T12:00:00Z')));
    await s.put(waiting('early', new Date('2026-11-11T08:00:00Z')));
    expect((await s.list()).map((i) => i.id)).toEqual(['early', 'late']);
  });

  it('one client never sees another client\'s articles', async () => {
    const fake = fakeSupabase();
    const a = store(fake, 'client-a');
    const b = store(fake, 'client-b');
    await a.put(waiting('same-slug'));
    await b.put({ ...waiting('same-slug'), title: 'B title' });
    expect((await a.get('same-slug'))?.title).toBe('Title same-slug');
    expect((await b.get('same-slug'))?.title).toBe('B title');
    await b.put(waiting('only-b'));
    expect((await a.list()).map((i) => i.id)).toEqual(['same-slug']);
    expect(await a.get('only-b')).toBeUndefined();
  });

  it('reads long inboxes in pages and misses nothing', async () => {
    const fake = fakeSupabase();
    const s = new SupabaseInboxStore({ url: URL_, key: KEY, clientId: 'c1', fetch: fake.f, pageSize: 2 });
    for (let n = 1; n <= 5; n++) await s.put(waiting(`item-${n}`, new Date(Date.UTC(2026, 10, 11, n))));
    expect((await s.list()).map((i) => i.id)).toEqual(['item-1', 'item-2', 'item-3', 'item-4', 'item-5']);
    expect(fake.seen.filter((c) => c.method === 'GET')).toHaveLength(3);
  });

  it('asks for the right thing: key, client filter, safe id, one upsert request', async () => {
    const fake = fakeSupabase();
    const s = store(fake, 'client with space');
    await s.put(waiting('a/b?c'));
    await s.get('a/b?c');
    const [post, get] = fake.seen;
    expect(post!.method).toBe('POST');
    expect(post!.url.searchParams.get('on_conflict')).toBe('client_id,id');
    expect(post!.headers.Prefer).toContain('resolution=merge-duplicates');
    expect(post!.headers.apikey).toBe(KEY);
    expect((post!.body as { client_id: string }[])[0]!.client_id).toBe('client with space');
    expect(get!.url.searchParams.get('client_id')).toBe('eq.client with space');
    expect(get!.url.searchParams.get('id')).toBe('eq.a/b?c');
  });

  it('a failed request is a clear error with the status, never a silent loss', async () => {
    const s = store(fakeSupabase({ failWith: 503 }));
    await expect(s.put(waiting('a'))).rejects.toThrow(/POST failed \(503\)/);
    await expect(s.list()).rejects.toThrow(/GET failed \(503\)/);
    const wrongKey = new SupabaseInboxStore({ url: URL_, key: 'wrong', clientId: 'c1', fetch: fakeSupabase().f });
    await expect(wrongKey.list()).rejects.toThrow(/401/);
  });

  it('a row that breaks the rules is an error, not a guess', async () => {
    const fake = fakeSupabase();
    const s = store(fake);
    await s.put(waiting('a'));
    fake.rows[0]!.status = 'nonsense';
    await expect(s.get('a')).rejects.toThrow(/not a valid approval inbox item/);
  });

  it('refuses to start without a url, key or client id', () => {
    const f = fakeSupabase().f;
    expect(() => new SupabaseInboxStore({ url: '', key: KEY, clientId: 'c', fetch: f })).toThrow(SupabaseError);
    expect(() => new SupabaseInboxStore({ url: URL_, key: ' ', clientId: 'c', fetch: f })).toThrow(SupabaseError);
    expect(() => new SupabaseInboxStore({ url: URL_, key: KEY, clientId: '', fetch: f })).toThrow(SupabaseError);
  });

  it('row conversion round-trips and trims a trailing slash on the url', async () => {
    const item = { ...waiting('a'), note: 'n' };
    expect(fromRow(toRow('c1', item))).toStrictEqual(item);
    const fake = fakeSupabase();
    await new SupabaseInboxStore({ url: `${URL_}//`, key: KEY, clientId: 'c1', fetch: fake.f }).list();
    expect(fake.seen[0]!.url.pathname).toBe('/rest/v1/inbox_items');
  });
});

describe('the same inbox rules work on the hosted store', () => {
  function fakeConnector(behaviour: (n: number) => 'ok' | 'refuse' = () => 'ok') {
    const calls: PublishItem[] = [];
    const c: Connector = {
      type: 'fake',
      check: async () => [],
      publish: async (items) => {
        const mode = behaviour(calls.length);
        calls.push(items[0]!);
        if (mode === 'refuse') return [{ slug: items[0]!.slug, ok: false, note: 'Rejected by the site.' }];
        return [{ slug: items[0]!.slug, ok: true, url: `https://site.example/${items[0]!.slug}`, handle: {} }];
      },
      revert: async () => ({ ok: true, note: 'undone' }),
    };
    return { c, calls };
  }

  it('approve with an edit, then publish: the edited text goes out and the item ends up published', async () => {
    const s = store(fakeSupabase());
    await s.put(waiting('a'));
    const approved = await decide(s, 'a', 'approve', { by: 'manny', editedBody: 'Corrected text.', now: new Date('2026-11-11T12:00:00Z') });
    expect(approved).toMatchObject({ status: 'approved', edited: true, decidedBy: 'manny', decidedAt: '2026-11-11T12:00:00.000Z' });
    const { c, calls } = fakeConnector();
    const out = await publishApproved(s, profile, c);
    expect(out).toEqual([expect.objectContaining({ id: 'a', ok: true })]);
    expect(calls[0]!.body).toBe('Corrected text.');
    expect(await s.get('a')).toMatchObject({ status: 'published', deliveredTo: 'https://site.example/a' });
  });

  it('a refused delivery stays publish_failed, is retried next run, and is never published twice', async () => {
    const s = store(fakeSupabase());
    await s.put(waiting('a'));
    await decide(s, 'a', 'approve', { by: 'm' });
    const flaky = fakeConnector((n) => (n === 0 ? 'refuse' : 'ok'));
    await publishApproved(s, profile, flaky.c);
    expect(await s.get('a')).toMatchObject({ status: 'publish_failed', deliveryNote: 'Rejected by the site.' });
    await publishApproved(s, profile, flaky.c);
    expect((await s.get('a'))?.status).toBe('published');
    await publishApproved(s, profile, flaky.c);
    expect(flaky.calls).toHaveLength(2);
  });

  it('rejected and published articles are protected', async () => {
    const s = store(fakeSupabase());
    await s.put(waiting('r'));
    await decide(s, 'r', 'reject', { by: 'm', note: 'off brand' });
    const { c, calls } = fakeConnector();
    await publishApproved(s, profile, c);
    expect(calls).toHaveLength(0);
    await s.put({ ...waiting('p'), status: 'published' });
    await expect(decide(s, 'p', 'reject', { by: 'm' })).rejects.toThrow(/already published/);
  });
});
