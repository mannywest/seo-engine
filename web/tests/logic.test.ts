import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { DemoSource, LiveSource } from '../src/data';
import { demoItems } from '../src/demo';
import { parseRow, RowError } from '../src/rows';
import { RuleError } from '../src/rules';
import { itemsFor, parseBody, safeUrl, scoreTone, tabOf, timeAgo, wordCount } from '../src/text';
import type { InboxItem } from '../src/types';

const NOW = new Date('2026-11-11T12:00:00.000Z');
const items = () => demoItems(NOW);
const byId = (id: string) => items().find((i) => i.id === id)!;

const row = (o: Record<string, unknown> = {}) => ({
  client_id: 'c1', id: 'a', added_at: '2026-11-11T10:00:00+00:00', status: 'waiting', reason: 'r', title: 'T', description: 'D',
  tags: ['x'], body: 'Body', topic: { title: 'T', slug: 'a', keyword: 'k', intent: 'info', outline: ['o'] },
  sources: [{ title: 'S', url: 'https://e.com' }], quality: { passed: true, score: 90, issues: [], warnings: [] },
  decided_at: null, decided_by: null, note: null, edited: null, delivered_to: null, delivery_note: null, ledger_id: null, ...o,
});

describe('reading database rows', () => {
  it('turns a row into an item: ISO times, nulls dropped, client id kept', () => {
    const i = parseRow(row());
    expect(i.addedAt).toBe('2026-11-11T10:00:00.000Z');
    expect(i.clientId).toBe('c1');
    expect(Object.keys(i)).not.toContain('note');
    expect(Object.keys(i)).not.toContain('decidedAt');
  });
  it('keeps decision and delivery details when present', () => {
    const i = parseRow(row({ status: 'published', decided_at: '2026-11-11T11:00:00+00:00', decided_by: 'a@b.com', note: 'n', edited: true, delivered_to: 'https://s', ledger_id: 'l1' }));
    expect(i).toMatchObject({ decidedAt: '2026-11-11T11:00:00.000Z', decidedBy: 'a@b.com', note: 'n', edited: true, deliveredTo: 'https://s', ledgerId: 'l1' });
  });
  it('a row that does not fit is an error, not a guess', () => {
    expect(() => parseRow(row({ status: 'nonsense' }))).toThrow(RowError);
    expect(() => parseRow(row({ title: undefined }))).toThrow(/title/);
    expect(() => parseRow(row({ quality: { passed: 'yes' } }))).toThrow(/quality/);
    expect(() => parseRow(null)).toThrow(RowError);
  });
});

describe('the demo inbox follows the same rules', () => {
  it('approving with a change marks it edited and records who and when', async () => {
    const d = new DemoSource(items(), { now: () => NOW });
    const r = await d.approve(byId('ceramic-coating-worth-it'), 'Fixed text.');
    expect(r).toMatchObject({ status: 'approved', edited: true, body: 'Fixed text.', decidedBy: 'you@demo', decidedAt: NOW.toISOString() });
    expect((await d.list()).find((i) => i.id === 'ceramic-coating-worth-it')?.status).toBe('approved');
  });
  it('approving without changes does not mark it edited', async () => {
    const d = new DemoSource(items());
    const item = byId('how-often-should-you-wash-your-car');
    expect(await d.approve(item, item.body)).not.toHaveProperty('edited');
  });
  it('rejecting keeps the note', async () => {
    const d = new DemoSource(items());
    expect(await d.reject(byId('ceramic-coating-worth-it'), '  Not accurate  ')).toMatchObject({ status: 'rejected', note: 'Not accurate' });
  });
  it('refuses empty edits and anything already published', async () => {
    const d = new DemoSource(items());
    await expect(d.approve(byId('ceramic-coating-worth-it'), '  ')).rejects.toThrow(RuleError);
    await expect(d.reject(byId('winter-wash-tips'))).rejects.toThrow(/already published/);
    await expect(d.approve(byId('winter-wash-tips'))).rejects.toThrow(/already published/);
    expect((await d.list()).find((i) => i.id === 'ceramic-coating-worth-it')?.status).toBe('waiting');
  });
});

/** The real Supabase library talking to a pretend server, so we see exactly what it would send. */
function pretendSupabase(initial: Record<string, unknown>[], failPatch?: { status: number; message: string }) {
  const rows = initial.map((r) => ({ ...r }));
  const seen: { method: string; url: URL; headers: Headers; body?: Record<string, unknown> }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    seen.push({ method, url, headers, ...(body ? { body } : {}) });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
    if (method === 'GET') return json(rows);
    if (method === 'PATCH') {
      if (failPatch) return json({ message: failPatch.message }, failPatch.status);
      const cid = url.searchParams.get('client_id')?.replace('eq.', '');
      const id = url.searchParams.get('id')?.replace('eq.', '');
      const hit = rows.find((r) => r.client_id === cid && r.id === id);
      if (!hit) return json({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }, 406);
      Object.assign(hit, body, { decided_at: '2026-11-11T12:00:00+00:00', decided_by: 'me@example.com' });
      return json(headers.get('Accept')?.includes('pgrst.object') ? hit : [hit]);
    }
    return json({}, 405);
  }) as typeof fetch;
  const db = createClient('https://abcd1234.supabase.co', 'anon-key', { global: { fetch: f }, auth: { persistSession: false, autoRefreshToken: false } });
  return { source: new LiveSource(db), seen, rows };
}

describe('the live source', () => {
  it('lists articles oldest first from the inbox table', async () => {
    const { source, seen } = pretendSupabase([row()]);
    const got = await source.list();
    expect(got.map((i) => i.id)).toEqual(['a']);
    expect(seen[0]!.url.pathname).toBe('/rest/v1/inbox_items');
    expect(seen[0]!.url.searchParams.get('order')).toBe('added_at.asc,id.asc');
    expect(seen[0]!.headers.get('apikey')).toBe('anon-key');
  });
  it('approve sends only the new status (not the text) when nothing was edited', async () => {
    const { source, seen } = pretendSupabase([row()]);
    const item = parseRow(row());
    const r = await source.approve(item, item.body);
    expect(r).toMatchObject({ status: 'approved', decidedBy: 'me@example.com' });
    const patch = seen.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual({ status: 'approved' });
    expect(patch.url.searchParams.get('client_id')).toBe('eq.c1');
    expect(patch.url.searchParams.get('id')).toBe('eq.a');
  });
  it('approve with a correction sends the new text', async () => {
    const { source, seen } = pretendSupabase([row()]);
    await source.approve(parseRow(row()), 'Better text.');
    expect(seen.find((c) => c.method === 'PATCH')!.body).toEqual({ status: 'approved', body: 'Better text.' });
  });
  it('reject sends the status and a trimmed note, never the text', async () => {
    const { source, seen } = pretendSupabase([row()]);
    await source.reject(parseRow(row()), ' off brand ');
    expect(seen.find((c) => c.method === 'PATCH')!.body).toEqual({ status: 'rejected', note: 'off brand' });
  });
  it('turns a refusal from the database into a clear message, and checks empty text first', async () => {
    const refused = pretendSupabase([row()], { status: 400, message: 'That article is already published.' });
    await expect(refused.source.reject(parseRow(row()))).rejects.toThrow(/Could not save that: That article is already published/);
    const { source, seen } = pretendSupabase([row()]);
    await expect(source.approve(parseRow(row()), '   ')).rejects.toThrow(RuleError);
    expect(seen.some((c) => c.method === 'PATCH')).toBe(false);
  });
  it('a missing row (not yours, or gone) is an error, not a silent success', async () => {
    const { source } = pretendSupabase([]);
    await expect(source.approve(parseRow(row()))).rejects.toThrow(/Could not save that/);
  });
});

describe('showing an article safely', () => {
  it('splits headings, paragraphs and lists', () => {
    const blocks = parseBody('## Title\n\nOne line\nsame paragraph.\n\n- a\n- b\n\n1. x\n2. y\n\n### Small');
    expect(blocks).toEqual([
      { type: 'h2', text: 'Title' },
      { type: 'p', text: 'One line same paragraph.' },
      { type: 'ul', items: ['a', 'b'] },
      { type: 'ol', items: ['x', 'y'] },
      { type: 'h3', text: 'Small' },
    ]);
  });
  it('never turns article text into markup', () => {
    const blocks = parseBody('<script>alert(1)</script>\n\n[x](javascript:alert(1))');
    expect(blocks).toEqual([
      { type: 'p', text: '<script>alert(1)</script>' },
      { type: 'p', text: '[x](javascript:alert(1))' },
    ]);
  });
  it('only web addresses become links', () => {
    expect(safeUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeUrl('data:text/html,hi')).toBeUndefined();
    expect(safeUrl('not a url')).toBeUndefined();
  });
  it('counts words and describes ages', () => {
    expect(wordCount('  one two\nthree ')).toBe(3);
    expect(wordCount('')).toBe(0);
    expect(timeAgo('2026-11-11T11:59:30.000Z', NOW)).toBe('just now');
    expect(timeAgo('2026-11-11T11:30:00.000Z', NOW)).toBe('30 min ago');
    expect(timeAgo('2026-11-11T09:00:00.000Z', NOW)).toBe('3 hours ago');
    expect(timeAgo('2026-11-09T12:00:00.000Z', NOW)).toBe('2 days ago');
  });
});

describe('sorting the inbox into tabs', () => {
  const all: InboxItem[] = items();
  it('puts each status where a person expects it', () => {
    expect(all.map((i) => [i.id, tabOf(i)])).toEqual([
      ['how-often-should-you-wash-your-car', 'needs'],
      ['ceramic-coating-worth-it', 'needs'],
      ['interior-valet-checklist', 'way'],
      ['winter-wash-tips', 'done'],
      ['cheapest-car-wash', 'done'],
    ]);
    expect(tabOf({ ...all[0]!, status: 'publish_failed' })).toBe('way');
  });
  it('shows the oldest waiting article first, and the most recent finished one first', () => {
    expect(itemsFor(all, 'needs').map((i) => i.id)).toEqual(['ceramic-coating-worth-it', 'how-often-should-you-wash-your-car']);
    expect(itemsFor(all, 'done').map((i) => i.id)).toEqual(['winter-wash-tips', 'cheapest-car-wash']);
  });
  it('colours the score by how safe the article looks', () => {
    expect(scoreTone(byId('ceramic-coating-worth-it'))).toBe('bad');
    expect(scoreTone(byId('how-often-should-you-wash-your-car'))).toBe('warn');
    expect(scoreTone(byId('winter-wash-tips'))).toBe('good');
  });
});

import { isServiceKey } from '../src/keys';
describe('keeping the powerful key out of the web app', () => {
  const jwt = (role: string) => `h.${btoa(JSON.stringify({ role })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.s`;
  it('spots a service key in either format and lets the public key through', () => {
    expect(isServiceKey(jwt('service_role'))).toBe(true);
    expect(isServiceKey('sb_secret_abc123')).toBe(true);
    expect(isServiceKey(jwt('anon'))).toBe(false);
    expect(isServiceKey('sb_publishable_abc123')).toBe(false);
    expect(isServiceKey('anon-key')).toBe(false);
    expect(isServiceKey('')).toBe(false);
  });
});
