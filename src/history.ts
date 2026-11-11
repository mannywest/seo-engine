import { join } from 'node:path';
import { FileEntryStore, hostedStore, StateError, type EntryStore, type OpenOptions } from './stateStore.js';

export interface HistoryEntry {
  slug: string;
  title: string;
  keyword: string;
  createdAt: string;
  passed: boolean;
  score: number;
  /** Where it was delivered (PR, WordPress post...) if a connector ran. */
  deliveredTo?: string;
}

/** The engine's memory of what it has already written for one client, so topics never repeat across runs. */
export class History {
  constructor(
    public entries: HistoryEntry[],
    private path: string,
    private store?: EntryStore<HistoryEntry>,
  ) {}

  /** Loads from the given store, or the local file data/<client>/history.json. */
  static async load(clientId: string, dataDir = 'data', store?: EntryStore<HistoryEntry>): Promise<History> {
    const s = store ?? new FileEntryStore<HistoryEntry>(join(dataDir, clientId, 'history.json'));
    let raw: unknown[] | undefined;
    try {
      raw = await s.read();
    } catch (e) {
      // A damaged local file starts a fresh history, as before. A hosted failure must stop the run: an empty history would repeat topics.
      if (!s.lenient) throw e;
      raw = undefined;
    }
    if (raw !== undefined && !s.lenient && !raw.every(isHistoryEntry)) {
      throw new StateError(`${s.where} holds an entry that is not a valid history entry.`);
    }
    return new History(Array.isArray(raw) ? (raw as HistoryEntry[]) : [], s.where, s);
  }

  /** The hosted history (Supabase) when SUPABASE_URL and SUPABASE_SERVICE_KEY are both set, otherwise the local file. */
  static async open(clientId: string, o: OpenOptions = {}): Promise<History> {
    return History.load(
      clientId,
      o.dataDir,
      hostedStore<HistoryEntry>(clientId, o, {
        table: 'history_entries',
        keyColumn: 'slug',
        keyOf: (e) => e.slug,
        order: 'created_at.asc,slug.asc',
        indexColumns: (e) => ({ created_at: e.createdAt }),
      }),
    );
  }

  slugs(): string[] {
    return this.entries.map((e) => e.slug);
  }

  add(e: HistoryEntry) {
    this.entries.push(e);
  }

  lastRun(): Date | null {
    if (!this.entries.length) return null;
    return new Date(Math.max(...this.entries.map((e) => Date.parse(e.createdAt))));
  }

  /** True when enough days have passed to honour the client's articles-per-week cadence. */
  isDue(cadencePerWeek: number, now = new Date()): boolean {
    if (cadencePerWeek <= 0) return false;
    const last = this.lastRun();
    if (!last) return true;
    const minDays = 7 / cadencePerWeek;
    return (now.getTime() - last.getTime()) / 86_400_000 >= minDays - 0.1;
  }

  async save() {
    await (this.store ?? new FileEntryStore<HistoryEntry>(this.path)).write(this.entries);
  }
}

function isHistoryEntry(e: unknown): e is HistoryEntry {
  const x = e as Partial<HistoryEntry> | null;
  return !!x && typeof x === 'object' && typeof x.slug === 'string' && typeof x.createdAt === 'string' && typeof x.title === 'string';
}
