import type { Fetch } from './types';

/** A database call failed. The message carries the status only, never the response body (it could hold something private). */
export class DbError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Supabase's plain web interface (PostgREST) with the SERVICE key. This bypasses row-level security, so every caller
 * must have proved who the person is first (see connect.ts). Older JWT-style keys go in both headers; new sb_secret_ keys in apikey only.
 */
export class Db {
  private readonly fetchFn: Fetch;

  constructor(
    private readonly url: string,
    private readonly key: string,
    fetchFn: Fetch = (input, init) => fetch(input, init),
  ) {
    // Cloudflare refuses the real fetch when it is called as "this.something(...)" (Illegal invocation), so always call it plainly.
    this.fetchFn = (input, init) => fetchFn(input, init);
  }

  private base() {
    return this.url.replace(/\/+$/, '');
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { apikey: this.key, ...(this.key.startsWith('sb_') ? {} : { Authorization: `Bearer ${this.key}` }), 'Content-Type': 'application/json', ...extra };
  }

  private async send(method: string, path: string, label: string, body?: unknown, extra: Record<string, string> = {}): Promise<unknown> {
    const res = await this.fetchFn(`${this.base()}/rest/v1/${path}`, { method, headers: this.headers(extra), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!res.ok) throw new DbError(`Database ${method} ${label} failed (${res.status})`, res.status);
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  }

  async select<T>(table: string, query: string): Promise<T[]> {
    return ((await this.send('GET', `${table}?${query}`, table)) as T[] | undefined) ?? [];
  }

  async insert(table: string, row: Record<string, unknown>): Promise<void> {
    await this.send('POST', table, table, row, { Prefer: 'return=minimal' });
  }

  /** Changes the rows matching `query` and returns them. An empty list means nothing matched, which is how single-use is enforced. */
  async patch<T>(table: string, query: string, changes: Record<string, unknown>): Promise<T[]> {
    return ((await this.send('PATCH', `${table}?${query}`, table, changes, { Prefer: 'return=representation' })) as T[] | undefined) ?? [];
  }

  async upsert(table: string, row: Record<string, unknown>, onConflict: string): Promise<void> {
    await this.send('POST', `${table}?on_conflict=${encodeURIComponent(onConflict)}`, table, row, { Prefer: 'resolution=merge-duplicates,return=minimal' });
  }

  async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T | undefined> {
    return (await this.send('POST', `rpc/${fn}`, `rpc ${fn}`, args)) as T | undefined;
  }

  /** Who a sign-in token belongs to, or undefined when it is missing, expired or not genuine. Asks Supabase, so no secret is needed here. */
  async userFromToken(jwt: string): Promise<{ id: string; email?: string } | undefined> {
    const res = await this.fetchFn(`${this.base()}/auth/v1/user`, { headers: { apikey: this.key, Authorization: `Bearer ${jwt}` } });
    if (res.status === 401 || res.status === 403) return undefined;
    if (!res.ok) throw new DbError(`Sign-in check failed (${res.status})`, res.status);
    const u = (await res.json()) as { id?: unknown; email?: unknown };
    if (typeof u.id !== 'string' || !u.id) return undefined;
    return { id: u.id, ...(typeof u.email === 'string' ? { email: u.email } : {}) };
  }
}
