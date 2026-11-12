import type { SupabaseClient } from '@supabase/supabase-js';
import { parseRow } from './rows';
import { approved, checkApprove, checkReject, checkSave, rejected, saved } from './rules';
import type { InboxItem } from './types';

/** Where the screen gets its articles and sends decisions. Two kinds: the real database, and a demo. */
export interface InboxSource {
  mode: 'live' | 'demo';
  list(): Promise<InboxItem[]>;
  /** Keeps edits as a draft. The article stays waiting; nothing is approved. */
  save(item: InboxItem, body: string): Promise<InboxItem>;
  approve(item: InboxItem, editedBody?: string): Promise<InboxItem>;
  reject(item: InboxItem, note?: string): Promise<InboxItem>;
}

/** Reads and decides articles in Supabase as the logged-in person. The database decides what is allowed. */
export class LiveSource implements InboxSource {
  readonly mode = 'live' as const;
  constructor(private readonly db: SupabaseClient) {}

  async list(): Promise<InboxItem[]> {
    const { data, error } = await this.db.from('inbox_items').select('*').order('added_at', { ascending: true }).order('id', { ascending: true });
    if (error) throw new Error(`Could not load your articles: ${error.message}`);
    return (data ?? []).map(parseRow);
  }

  async save(item: InboxItem, body: string): Promise<InboxItem> {
    checkSave(item, body);
    // Only the text is sent. The status is left alone, so the article stays waiting.
    return this.update(item, { body });
  }

  async approve(item: InboxItem, editedBody?: string): Promise<InboxItem> {
    checkApprove(item, editedBody);
    const patch: Record<string, unknown> = { status: 'approved' };
    if (editedBody !== undefined && editedBody !== item.body) patch.body = editedBody;
    return this.update(item, patch);
  }

  async reject(item: InboxItem, note?: string): Promise<InboxItem> {
    checkReject(item);
    const patch: Record<string, unknown> = { status: 'rejected' };
    if (note?.trim()) patch.note = note.trim();
    return this.update(item, patch);
  }

  private async update(item: InboxItem, patch: Record<string, unknown>): Promise<InboxItem> {
    const { data, error } = await this.db
      .from('inbox_items')
      .update(patch)
      .eq('client_id', item.clientId)
      .eq('id', item.id)
      .select()
      .single();
    if (error) throw new Error(`Could not save that: ${error.message}`);
    return parseRow(data);
  }
}

/** Sample articles held in memory so the screen can be tried before any account exists. */
export class DemoSource implements InboxSource {
  readonly mode = 'demo' as const;
  private items: InboxItem[];
  constructor(
    items: InboxItem[],
    private readonly o: { delayMs?: number; by?: string; now?: () => Date } = {},
  ) {
    this.items = items.map((i) => ({ ...i }));
  }
  private async pause() {
    if (this.o.delayMs) await new Promise((r) => setTimeout(r, this.o.delayMs));
  }
  private put(next: InboxItem): InboxItem {
    this.items = this.items.map((i) => (i.id === next.id ? next : i));
    return { ...next };
  }
  private find(id: string): InboxItem {
    const hit = this.items.find((i) => i.id === id);
    if (!hit) throw new Error('That article is not in the inbox any more.');
    return hit;
  }
  async list() {
    await this.pause();
    return this.items.map((i) => ({ ...i }));
  }
  async save(item: InboxItem, body: string) {
    await this.pause();
    return this.put(saved(this.find(item.id), { body }));
  }
  async approve(item: InboxItem, editedBody?: string) {
    await this.pause();
    return this.put(approved(this.find(item.id), { by: this.o.by ?? 'you@demo', now: (this.o.now ?? (() => new Date()))(), ...(editedBody !== undefined ? { editedBody } : {}) }));
  }
  async reject(item: InboxItem, note?: string) {
    await this.pause();
    return this.put(rejected(this.find(item.id), { by: this.o.by ?? 'you@demo', now: (this.o.now ?? (() => new Date()))(), ...(note !== undefined ? { note } : {}) }));
  }
}
