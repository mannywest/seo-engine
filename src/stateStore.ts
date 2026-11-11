import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Where the engine keeps its notebook for one client: what it has written (history), every change it made to the
 * client's site (ledger), the facts the business confirmed (facts vault) and AI usage (usage log).
 *
 * Two places can hold it, behind the same small interface:
 *   - a local file (the default, for running on your own computer), and
 *   - Supabase tables (for GitHub Actions, where local files vanish when a run ends).
 */
export interface EntryStore<T> {
  /** The stored entries as they are, or undefined when nothing has been stored yet. */
  read(): Promise<unknown[] | undefined>;
  /** Saves the whole list as it now stands. */
  write(entries: T[]): Promise<void>;
  /** Where the entries live, for error messages. */
  readonly where: string;
  /** True only for the local file: a read that fails may be treated as "empty". Never for the hosted store, where it would hide an outage. */
  readonly lenient: boolean;
}

export class StateError extends Error {}
export class HostedConfigError extends Error {}

type Env = Record<string, string | undefined>;

/**
 * The hosted settings, or undefined when neither is set. Blank counts as not set, because an unset GitHub secret arrives as "".
 * Only one of the two being set is an error, never a quiet fallback: a local file disappears when a GitHub run ends.
 */
export function hostedSettings(env: Env = process.env): { url: string; key: string } | undefined {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_KEY?.trim();
  if (url && key) return { url, key };
  if (url || key) {
    throw new HostedConfigError(
      `The hosted notebook is half set up: ${url ? 'SUPABASE_SERVICE_KEY' : 'SUPABASE_URL'} is missing. Set both, or neither to use local files.`,
    );
  }
  return undefined;
}

/**
 * The headers every Supabase request carries. Older JWT-style keys (eyJ...) go in both `apikey` and `Authorization`.
 * New-style keys (sb_secret_..., sb_publishable_...) are not login tokens, so they go in `apikey` only.
 */
export function supabaseHeaders(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: key, ...(key.startsWith('sb_') ? {} : { Authorization: `Bearer ${key}` }), 'Content-Type': 'application/json', ...extra };
}

export class FileEntryStore<T> implements EntryStore<T> {
  readonly lenient = true;
  constructor(private readonly path: string) {}

  get where(): string {
    return this.path;
  }

  async read(): Promise<unknown[] | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
    return JSON.parse(raw) as unknown[];
  }

  async write(entries: T[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(entries, null, 2) + '\n', 'utf8');
  }
}

export interface OpenOptions {
  dataDir?: string;
  env?: Env;
  /** For tests. Defaults to the built-in fetch. */
  fetch?: typeof fetch;
}

export interface TableConfig<T> {
  table: string;
  /** Order the rows are read back in, as PostgREST writes it, e.g. "at.asc,id.asc". */
  order: string;
  /**
   * Entries that are changed later and found again by a key (ledger, facts, history). They are saved one row each,
   * and only the rows that changed since they were read, so two runs touching different rows do not overwrite each other.
   * Leave out for a log that is only ever added to (usage).
   */
  keyOf?: (entry: T) => string;
  /** Name of the key column. Default "id". */
  keyColumn?: string;
  /** Delete rows whose entry was removed since the read (facts). Never deletes anything that was not read first. */
  prune?: boolean;
  /** The few columns kept beside the entry so the tables can be searched and sorted in the dashboard. */
  indexColumns: (entry: T) => Record<string, unknown>;
}

const CHUNK = 200;

/** JSON with keys in a fixed order, so the same entry always gives the same text however its keys were ordered when it was read back. */
function canon(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/**
 * Entries kept in a Supabase table (see supabase/schema.sql), one row each: the entry itself in a `data` column
 * plus a few searchable columns. Uses Supabase's plain web interface (PostgREST) with `fetch`, like the hosted inbox,
 * so it needs no extra package and can be tested with a pretend server.
 */
export class SupabaseEntryStore<T> implements EntryStore<T> {
  readonly lenient = false;
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly keyColumn: string;
  /** What each row looked like when it was read or last saved, so only changed rows are sent. */
  private loaded = new Map<string, string>();
  private loadedCount = 0;

  constructor(
    private readonly o: { url: string; key: string; clientId: string; fetch?: typeof fetch } & TableConfig<T>,
  ) {
    if (!o.url.trim()) throw new StateError('The Supabase project URL is missing.');
    if (!o.key.trim()) throw new StateError('The Supabase service key is missing.');
    if (!o.clientId.trim()) throw new StateError('The client id is missing.');
    this.base = `${o.url.replace(/\/+$/, '')}/rest/v1/${o.table}`;
    this.doFetch = o.fetch ?? fetch;
    this.keyColumn = o.keyColumn ?? 'id';
  }

  get where(): string {
    return `the ${this.o.table} table for "${this.o.clientId}"`;
  }

  private async request(method: string, query: string, init: { body?: unknown; prefer?: string } = {}): Promise<unknown> {
    const res = await this.doFetch(query ? `${this.base}?${query}` : this.base, {
      method,
      headers: supabaseHeaders(this.o.key, init.prefer ? { Prefer: init.prefer } : {}),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new StateError(`Supabase ${method} on ${this.o.table} failed (${res.status}): ${text.slice(0, 300) || res.statusText}`);
    return text ? JSON.parse(text) : undefined;
  }

  private scope(): string {
    return `client_id=eq.${encodeURIComponent(this.o.clientId)}`;
  }

  async read(): Promise<unknown[] | undefined> {
    const entries: unknown[] = [];
    for (let offset = 0; ; offset += 500) {
      const rows = await this.request('GET', `select=data&${this.scope()}&order=${this.o.order}&limit=500&offset=${offset}`);
      if (!Array.isArray(rows)) throw new StateError(`The database did not return a list of rows from ${this.where}.`);
      for (const r of rows) {
        const data = (r as { data?: unknown } | null)?.data;
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          throw new StateError(`A row in ${this.where} has no readable entry in its data column.`);
        }
        entries.push(data);
      }
      if (rows.length < 500) break;
    }
    this.loadedCount = entries.length;
    this.loaded = new Map();
    if (this.o.keyOf) for (const e of entries) this.loaded.set(this.o.keyOf(e as T), canon(e));
    return entries.length ? entries : undefined;
  }

  async write(entries: T[]): Promise<void> {
    const keyOf = this.o.keyOf;
    if (!keyOf) {
      const fresh = entries.slice(this.loadedCount);
      for (let i = 0; i < fresh.length; i += CHUNK) {
        await this.request('POST', '', {
          body: fresh.slice(i, i + CHUNK).map((e) => ({ client_id: this.o.clientId, ...this.o.indexColumns(e), data: e })),
          prefer: 'return=minimal',
        });
      }
      this.loadedCount = entries.length;
      return;
    }

    // Last one wins when the same key appears twice, because one request cannot change a row twice.
    const current = new Map<string, T>();
    for (const e of entries) current.set(keyOf(e), e);
    const changed = [...current].filter(([k, e]) => this.loaded.get(k) !== canon(e));
    for (let i = 0; i < changed.length; i += CHUNK) {
      const slice = changed.slice(i, i + CHUNK);
      await this.request('POST', `on_conflict=client_id,${this.keyColumn}`, {
        body: slice.map(([k, e]) => ({ client_id: this.o.clientId, [this.keyColumn]: k, ...this.o.indexColumns(e), data: e })),
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
      for (const [k, e] of slice) this.loaded.set(k, canon(e));
    }
    if (this.o.prune) {
      const gone = [...this.loaded.keys()].filter((k) => !current.has(k));
      for (let i = 0; i < gone.length; i += CHUNK) {
        const list = gone
          .slice(i, i + CHUNK)
          .map((k) => `"${k.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
          .join(',');
        await this.request('DELETE', `${this.scope()}&${this.keyColumn}=in.(${encodeURIComponent(list)})`, { prefer: 'return=minimal' });
        for (const k of gone.slice(i, i + CHUNK)) this.loaded.delete(k);
      }
    }
  }
}

/** The hosted store for one table when SUPABASE_URL and SUPABASE_SERVICE_KEY are both set; undefined when neither is (use the local file). */
export function hostedStore<T>(clientId: string, o: OpenOptions, cfg: TableConfig<T>): SupabaseEntryStore<T> | undefined {
  const hosted = hostedSettings(o.env ?? process.env);
  if (!hosted) return undefined;
  return new SupabaseEntryStore<T>({ ...hosted, clientId, ...(o.fetch ? { fetch: o.fetch } : {}), ...cfg });
}
