import { supabaseHeaders } from './stateStore.js';
import { INBOX_STATUS, ItemSchema, type InboxItem, type InboxStore } from './inbox.js';

/**
 * The hosted inbox: the same InboxStore rules as the local file, kept in a Supabase table (see supabase/schema.sql)
 * so the web app and the engine read and write the same articles.
 *
 * It talks to Supabase's plain web interface (PostgREST) with `fetch`, so it needs no extra package and can be
 * tested with a pretend server before any Supabase account exists. One store holds one client's inbox.
 */
export interface SupabaseInboxOptions {
  /** Project URL, e.g. https://abcd1234.supabase.co */
  url: string;
  /** The service key (engine side). Never put this in the web app. */
  key: string;
  clientId: string;
  /** For tests. Defaults to the built-in fetch. */
  fetch?: typeof fetch;
  table?: string;
  /** Rows read per request. */
  pageSize?: number;
}

/** One row of the inbox_items table, exactly as the database names it. */
interface Row {
  client_id: string;
  id: string;
  added_at: string;
  status: string;
  reason: string;
  title: string;
  description: string;
  tags: string[];
  body: string;
  topic: InboxItem['topic'];
  sources: InboxItem['sources'];
  quality: InboxItem['quality'];
  decided_at: string | null;
  decided_by: string | null;
  note: string | null;
  edited: boolean | null;
  delivered_to: string | null;
  delivery_note: string | null;
  ledger_id: string | null;
}

export class SupabaseError extends Error {}

/** Every column is always sent, with null for "not set", so saving an item replaces it completely (as the file store does). */
export function toRow(clientId: string, i: InboxItem): Row {
  return {
    client_id: clientId,
    id: i.id,
    added_at: i.addedAt,
    status: i.status,
    reason: i.reason,
    title: i.title,
    description: i.description,
    tags: i.tags,
    body: i.body,
    topic: i.topic,
    sources: i.sources,
    quality: i.quality,
    decided_at: i.decidedAt ?? null,
    decided_by: i.decidedBy ?? null,
    note: i.note ?? null,
    edited: i.edited ?? null,
    delivered_to: i.deliveredTo ?? null,
    delivery_note: i.deliveryNote ?? null,
    ledger_id: i.ledgerId ?? null,
  };
}

/** Database timestamps come back in Postgres style; bring them back to the engine's own ISO form. */
function iso(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

/** Turns a database row back into an inbox item; a row that does not fit the rules is an error, not a guess. */
export function fromRow(row: unknown): InboxItem {
  const r = row as Partial<Row> | null;
  if (!r || typeof r !== 'object') throw new SupabaseError('The database returned something that is not an inbox row.');
  const candidate = {
    id: r.id,
    addedAt: typeof r.added_at === 'string' ? iso(r.added_at) : r.added_at,
    status: r.status,
    reason: r.reason,
    title: r.title,
    description: r.description,
    tags: r.tags,
    body: r.body,
    topic: r.topic,
    sources: r.sources,
    quality: r.quality,
    ...(r.decided_at != null ? { decidedAt: iso(r.decided_at) } : {}),
    ...(r.decided_by != null ? { decidedBy: r.decided_by } : {}),
    ...(r.note != null ? { note: r.note } : {}),
    ...(r.edited != null ? { edited: r.edited } : {}),
    ...(r.delivered_to != null ? { deliveredTo: r.delivered_to } : {}),
    ...(r.delivery_note != null ? { deliveryNote: r.delivery_note } : {}),
    ...(r.ledger_id != null ? { ledgerId: r.ledger_id } : {}),
  };
  const parsed = ItemSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new SupabaseError(
      `Inbox row "${String(r.id)}" is not a valid approval inbox item: ${first?.path.join('.') ?? ''} ${first?.message ?? ''}`.trim(),
    );
  }
  return parsed.data;
}

export class SupabaseInboxStore implements InboxStore {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly pageSize: number;

  constructor(private readonly o: SupabaseInboxOptions) {
    if (!o.url.trim()) throw new SupabaseError('The Supabase project URL is missing.');
    if (!o.key.trim()) throw new SupabaseError('The Supabase service key is missing.');
    if (!o.clientId.trim()) throw new SupabaseError('The client id is missing.');
    this.base = `${o.url.replace(/\/+$/, '')}/rest/v1/${o.table ?? 'inbox_items'}`;
    this.doFetch = o.fetch ?? fetch;
    this.pageSize = o.pageSize ?? 500;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return supabaseHeaders(this.o.key, extra);
  }

  private async request(method: string, query: string, init: { body?: unknown; prefer?: string } = {}): Promise<unknown> {
    const res = await this.doFetch(`${this.base}?${query}`, {
      method,
      headers: this.headers(init.prefer ? { Prefer: init.prefer } : {}),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new SupabaseError(`Supabase ${method} failed (${res.status}): ${text.slice(0, 300) || res.statusText}`);
    }
    return text ? JSON.parse(text) : undefined;
  }

  private scope(): string {
    return `client_id=eq.${encodeURIComponent(this.o.clientId)}`;
  }

  async list(): Promise<InboxItem[]> {
    const items: InboxItem[] = [];
    for (let offset = 0; ; offset += this.pageSize) {
      const rows = await this.request(
        'GET',
        `select=*&${this.scope()}&order=added_at.asc,id.asc&limit=${this.pageSize}&offset=${offset}`,
      );
      if (!Array.isArray(rows)) throw new SupabaseError('The database did not return a list of inbox rows.');
      items.push(...rows.map(fromRow));
      if (rows.length < this.pageSize) return items;
    }
  }

  async get(id: string): Promise<InboxItem | undefined> {
    const rows = await this.request('GET', `select=*&${this.scope()}&id=eq.${encodeURIComponent(id)}&limit=1`);
    if (!Array.isArray(rows)) throw new SupabaseError('The database did not return a list of inbox rows.');
    return rows[0] === undefined ? undefined : fromRow(rows[0]);
  }

  /** Adds or replaces one item (matched on client + id) in a single request. */
  async put(item: InboxItem): Promise<void> {
    if (!(INBOX_STATUS as readonly string[]).includes(item.status)) {
      throw new SupabaseError(`"${item.status}" is not an inbox status.`);
    }
    await this.request('POST', 'on_conflict=client_id,id', {
      body: [toRow(this.o.clientId, item)],
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  }
}
