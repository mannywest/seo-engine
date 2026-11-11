import { join } from 'node:path';
import type { LlmProvider, LlmRequest } from './providers/llm.js';
import { FileEntryStore, hostedStore, StateError, type EntryStore, type OpenOptions } from './stateStore.js';

export interface UsageEntry {
  at: string;
  task: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  /** True when counts are estimated from text length (about 4 characters per token). */
  estimated: boolean;
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export class CapReachedError extends Error {}

/** Per-client record of AI usage. Stored as tokens, not money: we do not guess prices. */
export class UsageLog {
  constructor(
    public entries: UsageEntry[],
    private path: string,
    private store?: EntryStore<UsageEntry>,
  ) {}

  /** Loads from the given store, or the local file data/<client>/usage.json. */
  static async load(clientId: string, dataDir = 'data', store?: EntryStore<UsageEntry>): Promise<UsageLog> {
    const s = store ?? new FileEntryStore<UsageEntry>(join(dataDir, clientId, 'usage.json'));
    let raw: unknown[] | undefined;
    try {
      raw = await s.read();
    } catch (e) {
      // A damaged local file starts a fresh log, as before. A hosted failure must stop the run: an empty log would bypass the monthly cap.
      if (!s.lenient) throw e;
      raw = undefined;
    }
    if (raw !== undefined && !s.lenient && !raw.every(isUsageEntry)) {
      throw new StateError(`${s.where} holds an entry that is not a valid usage entry.`);
    }
    return new UsageLog(Array.isArray(raw) ? (raw as UsageEntry[]) : [], s.where, s);
  }

  /** The hosted log (Supabase) when SUPABASE_URL and SUPABASE_SERVICE_KEY are both set, otherwise the local file. */
  static async open(clientId: string, o: OpenOptions = {}): Promise<UsageLog> {
    return UsageLog.load(
      clientId,
      o.dataDir,
      hostedStore<UsageEntry>(clientId, o, {
        table: 'usage_entries',
        order: 'id.asc',
        indexColumns: (e) => ({ at: e.at }),
      }),
    );
  }

  add(e: UsageEntry) {
    this.entries.push(e);
  }

  /** Entries for a calendar month, month = "YYYY-MM" (UTC). */
  forMonth(month: string): UsageEntry[] {
    return this.entries.filter((e) => e.at.startsWith(month));
  }

  totalTokens(month: string): number {
    return this.forMonth(month).reduce((n, e) => n + e.inputTokens + e.outputTokens, 0);
  }

  async save() {
    await (this.store ?? new FileEntryStore<UsageEntry>(this.path)).write(this.entries);
  }
}

function isUsageEntry(e: unknown): e is UsageEntry {
  const x = e as Partial<UsageEntry> | null;
  return !!x && typeof x === 'object' && typeof x.at === 'string' && typeof x.inputTokens === 'number' && typeof x.outputTokens === 'number';
}

/** Wraps any provider: records every call and refuses new ones once the monthly token cap is reached. */
export class MeteredProvider implements LlmProvider {
  constructor(
    private inner: LlmProvider,
    private log: UsageLog,
    private opts: { monthlyTokenCap?: number; now?: () => Date } = {},
  ) {}

  get name(): string {
    return this.inner.name;
  }

  async complete(req: LlmRequest): Promise<string> {
    const now = (this.opts.now ?? (() => new Date()))();
    const month = now.toISOString().slice(0, 7);
    const cap = this.opts.monthlyTokenCap;
    if (cap !== undefined && this.log.totalTokens(month) >= cap) {
      throw new CapReachedError(`Monthly AI usage cap (${cap} tokens) reached; stopping to protect cost.`);
    }
    const out = await this.inner.complete(req);
    this.log.add({
      at: now.toISOString(),
      task: req.task,
      provider: this.inner.name,
      inputTokens: estimateTokens(req.system + req.prompt),
      outputTokens: estimateTokens(out),
      estimated: true,
    });
    return out;
  }
}
