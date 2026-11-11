import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FactsVault } from '../src/facts.js';
import { History, type HistoryEntry } from '../src/history.js';
import { Ledger } from '../src/ledger.js';
import { HostedConfigError, hostedSettings, StateError } from '../src/stateStore.js';
import { MeteredProvider, UsageLog, CapReachedError } from '../src/usage.js';

const URL_ = 'https://abcd1234.supabase.co';
const KEY = 'service-key-for-tests';
const ENV = { SUPABASE_URL: URL_, SUPABASE_SERVICE_KEY: KEY };

interface Seen { method: string; table: string; query: URL['searchParams']; body?: unknown }

const KEYS: Record<string, string[]> = {
  history_entries: ['client_id', 'slug'],
  ledger_entries: ['client_id', 'id'],
  facts: ['client_id', 'id'],
  usage_entries: ['id'],
};

/** A pretend Supabase with the four notebook tables: answers the same web requests the real one does. */
function fakeSupabase(opts: { failWith?: number } = {}) {
  const tables: Record<string, Record<string, unknown>[]> = { history_entries: [], ledger_entries: [], facts: [], usage_entries: [] };
  const seen: Seen[] = [];
  let nextId = 1;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const table = url.pathname.split('/').pop() ?? '';
    seen.push({ method, table, query: url.searchParams, body });
    if (opts.failWith) return new Response('{"message":"boom"}', { status: opts.failWith });
    if (headers.apikey !== KEY || headers.Authorization !== `Bearer ${KEY}`) return new Response('{"message":"bad key"}', { status: 401 });
    const rows = tables[table];
    if (!rows) return new Response('{"message":"no such table"}', { status: 404 });
    const inClient = (r: Record<string, unknown>) => {
      const c = url.searchParams.get('client_id');
      return !c?.startsWith('eq.') || r.client_id === c.slice(3);
    };

    if (method === 'GET') {
      const [col, dir] = (url.searchParams.get('order') ?? '').split(',')[0]?.split('.') ?? [];
      const out = rows.filter(inClient).sort((a, b) => (col ? String(a[col]).localeCompare(String(b[col])) : 0) * (dir === 'desc' ? -1 : 1));
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 1000);
      return new Response(JSON.stringify(out.slice(offset, offset + limit).map((r) => ({ data: r.data }))), { status: 200 });
    }
    if (method === 'POST') {
      const batch = body as Record<string, unknown>[];
      const keyCols = KEYS[table] ?? [];
      const conflict = url.searchParams.get('on_conflict');
      if (table !== 'usage_entries') {
        if (conflict !== keyCols.join(',')) return new Response('{"message":"needs on_conflict"}', { status: 409 });
        if (!String(headers.Prefer).includes('resolution=merge-duplicates')) return new Response('{"message":"duplicate key"}', { status: 409 });
        const keys = batch.map((r) => keyCols.map((k) => r[k]).join('|'));
        if (new Set(keys).size !== keys.length) return new Response('{"message":"cannot affect row a second time"}', { status: 409 });
      }
      for (const row of batch) {
        if (typeof row.data !== 'object' || row.data === null || typeof row.client_id !== 'string') return new Response('{"message":"bad row"}', { status: 400 });
        if (table === 'usage_entries') {
          rows.push({ id: nextId++, ...row });
          continue;
        }
        const n = rows.findIndex((r) => keyCols.every((k) => r[k] === row[k]));
        if (n === -1) rows.push(row);
        else rows[n] = row;
      }
      return new Response(null, { status: 201 });
    }
    if (method === 'DELETE') {
      const c = url.searchParams.get('client_id');
      const idQ = url.searchParams.get('id');
      if (!c?.startsWith('eq.') || !idQ?.startsWith('in.(')) return new Response('{"message":"refusing unscoped delete"}', { status: 400 });
      const ids = [...idQ.slice(4, -1).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? '').replace(/\\(.)/g, '$1'));
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const r = rows[i] as Record<string, unknown>;
        if (r.client_id === c.slice(3) && ids.includes(String(r.id))) rows.splice(i, 1);
      }
      return new Response(null, { status: 204 });
    }
    return new Response('{}', { status: 405 });
  }) as typeof fetch;
  return { f, tables, seen };
}

const entry = (slug: string, at = '2026-11-10T09:00:00.000Z'): HistoryEntry => ({ slug, title: `T ${slug}`, keyword: 'k', createdAt: at, passed: true, score: 90 });

async function dir() {
  return mkdtemp(join(tmpdir(), 'state-'));
}

describe('choosing where the notebook lives', () => {
  it('uses the local files when neither setting is set (blank counts as unset)', async () => {
    const d = await dir();
    const h = await History.open('acme', { dataDir: d, env: { SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '  ' } });
    h.add(entry('a'));
    await h.save();
    expect((await History.open('acme', { dataDir: d, env: {} })).slugs()).toEqual(['a']);
  });

  it('stops with a clear message when only one setting is set, for all four stores', async () => {
    const d = await dir();
    for (const env of [{ SUPABASE_URL: URL_ }, { SUPABASE_SERVICE_KEY: KEY }]) {
      for (const open of [History.open, Ledger.open, FactsVault.open, UsageLog.open]) {
        await expect(open('acme', { dataDir: d, env })).rejects.toThrow(HostedConfigError);
      }
    }
    expect(() => hostedSettings({ SUPABASE_URL: URL_ })).toThrow(/SUPABASE_SERVICE_KEY is missing/);
  });

  it('uses the hosted tables when both are set, and writes nothing to local files', async () => {
    const d = await dir();
    const { f, tables } = fakeSupabase();
    const h = await History.open('acme', { dataDir: d, env: ENV, fetch: f });
    h.add(entry('a'));
    await h.save();
    expect(tables.history_entries).toHaveLength(1);
    expect((await History.open('acme', { dataDir: d, env: {} })).slugs()).toEqual([]); // the local file was never written
  });
});

describe('history in Supabase', () => {
  it('keeps what was written across runs, in order, and does not mix up clients', async () => {
    const { f } = fakeSupabase();
    const run1 = await History.open('acme', { env: ENV, fetch: f });
    run1.add(entry('b', '2026-11-11T09:00:00.000Z'));
    run1.add(entry('a', '2026-11-10T09:00:00.000Z'));
    await run1.save();
    const other = await History.open('zed', { env: ENV, fetch: f });
    other.add(entry('z'));
    await other.save();

    const run2 = await History.open('acme', { env: ENV, fetch: f });
    expect(run2.slugs()).toEqual(['a', 'b']);
    expect(run2.lastRun()?.toISOString()).toBe('2026-11-11T09:00:00.000Z');
    expect(run2.isDue(1, new Date('2026-11-13T09:00:00Z'))).toBe(false);
  });

  it('sends only new rows on a later save', async () => {
    const { f, seen } = fakeSupabase();
    const h = await History.open('acme', { env: ENV, fetch: f });
    h.add(entry('a'));
    await h.save();
    seen.length = 0;
    h.add(entry('b'));
    await h.save();
    const posts = seen.filter((s) => s.method === 'POST');
    expect(posts).toHaveLength(1);
    expect((posts[0]?.body as { slug: string }[]).map((r) => r.slug)).toEqual(['b']);
    seen.length = 0;
    await h.save(); // nothing changed
    expect(seen).toHaveLength(0);
  });

  it('refuses to carry on when the database cannot be read, instead of starting from an empty history', async () => {
    const { f } = fakeSupabase({ failWith: 500 });
    await expect(History.open('acme', { env: ENV, fetch: f })).rejects.toThrow(StateError);
  });

  it('refuses a stored entry that is not a history entry', async () => {
    const { f, tables } = fakeSupabase();
    tables.history_entries!.push({ client_id: 'acme', slug: 'x', created_at: '2026-11-10T09:00:00Z', data: { slug: 'x' } });
    await expect(History.open('acme', { env: ENV, fetch: f })).rejects.toThrow(/not a valid history entry/);
  });
});

describe('ledger in Supabase', () => {
  const change = { at: '2026-11-10T13:00:00.000Z', kind: 'publish' as const, slug: 's', title: 'S', connector: 'git', summary: 'Delivered', reversible: false, status: 'applied' as const };

  it('keeps entries across runs so an inbox item can still find its ledger id', async () => {
    const { f } = fakeSupabase();
    const run1 = await Ledger.open('acme', { env: ENV, fetch: f });
    const e = run1.add(change, new Date('2026-11-10T13:00:00Z'));
    await run1.save();
    const run2 = await Ledger.open('acme', { env: ENV, fetch: f });
    expect(run2.get(e.id)?.title).toBe('S');
  });

  it('saves only the entries that changed, so two runs touching different entries do not overwrite each other', async () => {
    const { f, seen, tables } = fakeSupabase();
    const first = await Ledger.open('acme', { env: ENV, fetch: f });
    const a = first.add({ ...change, slug: 'a' }, new Date('2026-11-10T13:00:00Z'));
    const b = first.add({ ...change, slug: 'b' }, new Date('2026-11-10T14:00:00Z'));
    await first.save();

    const runA = await Ledger.open('acme', { env: ENV, fetch: f });
    const runB = await Ledger.open('acme', { env: ENV, fetch: f });
    runA.get(a.id)!.status = 'reverted';
    runB.get(b.id)!.status = 'revert_pending';
    seen.length = 0;
    await runA.save();
    await runB.save();
    expect(seen.filter((s) => s.method === 'POST').map((s) => (s.body as { id: string }[]).map((r) => r.id))).toEqual([[a.id], [b.id]]);

    const after = await Ledger.open('acme', { env: ENV, fetch: f });
    expect(after.get(a.id)?.status).toBe('reverted');
    expect(after.get(b.id)?.status).toBe('revert_pending');
    expect(tables.ledger_entries!.map((r) => r.status).sort()).toEqual(['revert_pending', 'reverted']);
  });

  it('rejects stored data that is not a valid ledger', async () => {
    const { f, tables } = fakeSupabase();
    tables.ledger_entries!.push({ client_id: 'acme', id: 'x', at: '2026-11-10T13:00:00Z', status: 'applied', data: { id: 'x' } });
    await expect(Ledger.open('acme', { env: ENV, fetch: f })).rejects.toThrow(/not a valid change ledger/);
  });
});

describe('facts in Supabase', () => {
  it('keeps confirmed facts across runs, replaces one with the same id and removes one that was deleted', async () => {
    const { f, tables } = fakeSupabase();
    const v1 = await FactsVault.open('acme', { env: ENV, fetch: f });
    v1.upsert({ kind: 'hours', label: 'Opening hours', value: 'Mon-Fri 8am-6pm', verifiedAt: '2026-11-10' });
    v1.upsert({ kind: 'price', label: 'Boiler service', value: '£90', verifiedAt: '2026-11-10' });
    await v1.save();

    const v2 = await FactsVault.open('acme', { env: ENV, fetch: f });
    expect(v2.facts.map((x) => x.label).sort()).toEqual(['Boiler service', 'Opening hours']);
    v2.upsert({ kind: 'hours', label: 'Opening hours', value: 'Mon-Sat 8am-6pm', verifiedAt: '2026-11-11' });
    expect(v2.remove('price-boiler-service')).toBe(true);
    await v2.save();

    const v3 = await FactsVault.open('acme', { env: ENV, fetch: f });
    expect(v3.facts.map((x) => x.value)).toEqual(['Mon-Sat 8am-6pm']);
    expect(tables.facts).toHaveLength(1);
  });

  it('only ever removes rows of its own client, and never anything it did not read', async () => {
    const { f, tables, seen } = fakeSupabase();
    const other = await FactsVault.open('zed', { env: ENV, fetch: f });
    other.upsert({ kind: 'hours', label: 'Opening hours', value: '9-5', verifiedAt: '2026-11-10' });
    await other.save();

    const fresh = await FactsVault.open('acme', { env: ENV, fetch: f }); // reads nothing
    fresh.upsert({ kind: 'area', label: 'Area', value: 'Leeds', verifiedAt: '2026-11-10' });
    seen.length = 0;
    await fresh.save();
    expect(seen.some((s) => s.method === 'DELETE')).toBe(false);
    expect(tables.facts!.filter((r) => r.client_id === 'zed')).toHaveLength(1);
  });

  it('handles an id with quotes in it when removing', async () => {
    const { f, tables } = fakeSupabase();
    const v = await FactsVault.open('acme', { env: ENV, fetch: f });
    v.upsert({ kind: 'other', label: 'x', value: 'y', verifiedAt: '2026-11-10', id: 'we"ird\\id' });
    v.upsert({ kind: 'other', label: 'keep', value: 'y', verifiedAt: '2026-11-10' });
    await v.save();
    const v2 = await FactsVault.open('acme', { env: ENV, fetch: f });
    v2.remove('we"ird\\id');
    await v2.save();
    expect(tables.facts!.map((r) => r.id)).toEqual(['other-keep']);
  });
});

describe('usage log in Supabase', () => {
  it('keeps token counts across runs so the monthly cap holds', async () => {
    const { f } = fakeSupabase();
    const run1 = await UsageLog.open('acme', { env: ENV, fetch: f });
    const llm = { name: 'fake', complete: async () => 'x'.repeat(400) };
    const metered1 = new MeteredProvider(llm, run1, { monthlyTokenCap: 150, now: () => new Date('2026-11-10T09:00:00Z') });
    await metered1.complete({ task: 'draft', system: 's'.repeat(200), prompt: 'p'.repeat(200), maxTokens: 10 }); // 100 in + 100 out
    await run1.save();

    const run2 = await UsageLog.open('acme', { env: ENV, fetch: f });
    expect(run2.totalTokens('2026-11')).toBe(200);
    const metered2 = new MeteredProvider(llm, run2, { monthlyTokenCap: 150, now: () => new Date('2026-11-11T09:00:00Z') });
    await expect(metered2.complete({ task: 'draft', system: 's', prompt: 'p', maxTokens: 10 })).rejects.toThrow(CapReachedError);
  });

  it('adds only the new calls on each save', async () => {
    const { f, tables } = fakeSupabase();
    const u = await UsageLog.open('acme', { env: ENV, fetch: f });
    u.add({ at: '2026-11-10T09:00:00.000Z', task: 'a', provider: 'p', inputTokens: 1, outputTokens: 2, estimated: true });
    await u.save();
    u.add({ at: '2026-11-10T10:00:00.000Z', task: 'b', provider: 'p', inputTokens: 3, outputTokens: 4, estimated: true });
    await u.save();
    await u.save();
    expect(tables.usage_entries).toHaveLength(2);
    const again = await UsageLog.open('acme', { env: ENV, fetch: f });
    expect(again.entries.map((e) => e.task)).toEqual(['a', 'b']);
  });

  it('stops the run when the database cannot be read, rather than starting from zero usage', async () => {
    const { f } = fakeSupabase({ failWith: 503 });
    await expect(UsageLog.open('acme', { env: ENV, fetch: f })).rejects.toThrow(StateError);
  });
});
