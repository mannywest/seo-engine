import { join } from 'node:path';
import { z } from 'zod';
import { FileEntryStore, hostedStore, type EntryStore, type OpenOptions } from './stateStore.js';
import type { Source } from './types.js';

export const FACT_KINDS = ['hours', 'price', 'service', 'area', 'credential', 'guarantee', 'contact', 'policy', 'other'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

const FactSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(FACT_KINDS),
  /** Short name, e.g. "Opening hours" or "Boiler service price". */
  label: z.string().min(1),
  /** The fact exactly as the business confirmed it, e.g. "Mon-Fri 8am-6pm". */
  value: z.string().min(1),
  /** Date (YYYY-MM-DD) the business last confirmed this fact. */
  verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'verifiedAt must look like 2026-11-10'),
});
export type Fact = z.infer<typeof FactSchema>;

const FileSchema = z.array(FactSchema);

export const factId = (kind: FactKind, label: string): string =>
  `${kind}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`.slice(0, 60);

/** Facts older than this are still used but flagged for the business to re-confirm. */
export const STALE_AFTER_DAYS = 180;

/**
 * The business facts vault: things the business has confirmed about itself (hours, prices, services, areas, policies).
 * Drafts may state these and nothing else about the business. Stored per client as data/<client>/facts.json.
 */
export class FactsVault {
  constructor(
    public facts: Fact[],
    private path: string,
    private store?: EntryStore<Fact>,
  ) {}

  /** Nothing stored is an empty vault. Something stored that is invalid is an error, never silently ignored. */
  static async load(clientId: string, dataDir = 'data', store?: EntryStore<Fact>): Promise<FactsVault> {
    const s = store ?? new FileEntryStore<Fact>(join(dataDir, clientId, 'facts.json'));
    const raw = await s.read();
    if (raw === undefined) return new FactsVault([], s.where, s);
    const parsed = FileSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new Error(`${s.where} is not a valid facts file: ${first?.path.join('.') ?? ''} ${first?.message ?? ''}`.trim());
    }
    return new FactsVault(parsed.data, s.where, s);
  }

  /** The hosted vault (Supabase) when SUPABASE_URL and SUPABASE_SERVICE_KEY are both set, otherwise the local file. */
  static async open(clientId: string, o: OpenOptions = {}): Promise<FactsVault> {
    return FactsVault.load(
      clientId,
      o.dataDir,
      hostedStore<Fact>(clientId, o, {
        table: 'facts',
        keyOf: (f) => f.id,
        prune: true,
        order: 'kind.asc,id.asc',
        indexColumns: (f) => ({ kind: f.kind, verified_at: f.verifiedAt }),
      }),
    );
  }

  get isEmpty(): boolean {
    return this.facts.length === 0;
  }

  ofKind(...kinds: FactKind[]): Fact[] {
    return this.facts.filter((f) => kinds.includes(f.kind));
  }

  /** Adds a fact, or replaces the one with the same id. Returns the stored fact. */
  upsert(input: { kind: FactKind; label: string; value: string; verifiedAt?: string; id?: string }, now = new Date()): Fact {
    const fact = FactSchema.parse({
      id: input.id ?? factId(input.kind, input.label),
      kind: input.kind,
      label: input.label.trim(),
      value: input.value.trim(),
      verifiedAt: input.verifiedAt ?? now.toISOString().slice(0, 10),
    });
    const i = this.facts.findIndex((f) => f.id === fact.id);
    if (i === -1) this.facts.push(fact);
    else this.facts[i] = fact;
    return fact;
  }

  remove(id: string): boolean {
    const before = this.facts.length;
    this.facts = this.facts.filter((f) => f.id !== id);
    return this.facts.length < before;
  }

  /** Facts the business has not re-confirmed for more than STALE_AFTER_DAYS. */
  stale(now = new Date(), maxAgeDays = STALE_AFTER_DAYS): Fact[] {
    const cutoff = now.getTime() - maxAgeDays * 86_400_000;
    return this.facts.filter((f) => Date.parse(`${f.verifiedAt}T00:00:00Z`) < cutoff);
  }

  /** The instruction block added to the writing prompt. */
  promptBlock(): string {
    if (this.isEmpty) {
      return 'No verified business facts are on file. Do not state hours, prices, phone numbers, email addresses, guarantees, credentials, years in business or service areas for the business.';
    }
    return [
      "Verified business facts (confirmed by the business). These are the ONLY facts you may state about the business's own hours, prices, contact details, services, areas, credentials, guarantees and policies. Use them exactly. If a fact is not listed, do not state it:",
      ...this.facts.map((f) => `- ${f.label}: ${f.value}`),
    ].join('\n');
  }

  /** The vault as a source, so figures taken from it count as supported by the quality check and appear in the proof pack. */
  asSource(): Source {
    return {
      title: 'Verified business facts (confirmed by the business)',
      url: 'vault://facts',
      snippet: this.facts.map((f) => `${f.label}: ${f.value}.`).join(' '),
    };
  }

  async save() {
    const sorted = [...this.facts].sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
    await (this.store ?? new FileEntryStore<Fact>(this.path)).write(sorted);
  }
}
