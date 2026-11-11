import { join } from 'node:path';
import { z } from 'zod';
import type { Connector, PublishContext, PublishResult, RevertContext } from './connectors/types.js';
import { FileEntryStore, hostedStore, type EntryStore, type OpenOptions } from './stateStore.js';

const EntrySchema = z.object({
  id: z.string().min(1),
  at: z.string(),
  kind: z.enum(['publish', 'revert']),
  slug: z.string(),
  title: z.string(),
  /** Which connector made the change, e.g. "wordpress". */
  connector: z.string(),
  /** One plain-English line for the owner. */
  summary: z.string(),
  url: z.string().optional(),
  /** What the connector needs to undo this. Absent when it cannot be undone. */
  handle: z.record(z.unknown()).optional(),
  reversible: z.boolean(),
  notReversibleBecause: z.string().optional(),
  status: z.enum(['applied', 'reverted', 'revert_pending', 'revert_failed']),
  /** On an undo entry: the id of the change it took back. */
  reverts: z.string().optional(),
  /** On a change: the id of the undo entry. */
  revertedBy: z.string().optional(),
  note: z.string().optional(),
});
export type LedgerEntry = z.infer<typeof EntrySchema>;

const FileSchema = z.array(EntrySchema);

/** A record of every change the engine makes to a client's site, with what is needed to take it back. Stored as data/<client>/ledger.json. */
export class Ledger {
  constructor(
    public entries: LedgerEntry[],
    private path: string,
    private store?: EntryStore<LedgerEntry>,
  ) {}

  /** Nothing stored is an empty ledger. Something stored that is invalid is an error, never silently ignored. */
  static async load(clientId: string, dataDir = 'data', store?: EntryStore<LedgerEntry>): Promise<Ledger> {
    const s = store ?? new FileEntryStore<LedgerEntry>(join(dataDir, clientId, 'ledger.json'));
    const raw = await s.read();
    if (raw === undefined) return new Ledger([], s.where, s);
    const parsed = FileSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new Error(`${s.where} is not a valid change ledger: ${first?.path.join('.') ?? ''} ${first?.message ?? ''}`.trim());
    }
    return new Ledger(parsed.data, s.where, s);
  }

  /** The hosted ledger (Supabase) when SUPABASE_URL and SUPABASE_SERVICE_KEY are both set, otherwise the local file. */
  static async open(clientId: string, o: OpenOptions = {}): Promise<Ledger> {
    return Ledger.load(
      clientId,
      o.dataDir,
      hostedStore<LedgerEntry>(clientId, o, {
        table: 'ledger_entries',
        keyOf: (e) => e.id,
        order: 'at.asc,id.asc',
        indexColumns: (e) => ({ at: e.at, status: e.status }),
      }),
    );
  }

  get(id: string): LedgerEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  add(e: Omit<LedgerEntry, 'id'>, now = new Date()): LedgerEntry {
    const base = `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}-${e.slug}`.slice(0, 90);
    let id = base;
    for (let n = 2; this.get(id); n += 1) id = `${base}-${n}`;
    const entry = { ...e, id };
    this.entries.push(entry);
    return entry;
  }

  async save() {
    await (this.store ?? new FileEntryStore<LedgerEntry>(this.path)).write(this.entries);
  }
}

/** Notes one delivery that went through. Deliveries that did not go through changed nothing, so they are not recorded. */
export function recordDelivery(
  ledger: Ledger,
  connector: Connector,
  item: { slug: string; title: string },
  result: PublishResult,
  ctx: Pick<PublishContext, 'mode'>,
  now = new Date(),
): LedgerEntry {
  const canUndo = typeof connector.revert === 'function' && !!result.handle;
  const why = !connector.revert
    ? `The ${connector.type} connector hands articles to another system, so they cannot be taken back from here. Remove it on the receiving site.`
    : !result.handle
      ? 'The connector did not return what is needed to undo this one.'
      : undefined;
  return ledger.add(
    {
      at: now.toISOString(),
      kind: 'publish',
      slug: item.slug,
      title: item.title,
      connector: connector.type,
      summary: `Delivered "${item.title}" through ${connector.type} (${ctx.mode === 'auto' ? 'live' : 'held for approval'}).`,
      ...(result.url ? { url: result.url } : {}),
      ...(canUndo && result.handle ? { handle: result.handle } : {}),
      reversible: canUndo,
      ...(why ? { notReversibleBecause: why } : {}),
      status: 'applied',
      ...(result.note ? { note: result.note } : {}),
    },
    now,
  );
}

export interface RevertOutcome {
  ok: boolean;
  /** Nothing was changed because undoing would destroy later edits. */
  refused?: boolean;
  /** An undo is prepared but needs approval (for example a pull request to merge). */
  pending?: boolean;
  message: string;
  url?: string;
}

/** Takes one change back, safely. Anything that cannot be done safely is refused with the reason, and nothing is changed. */
export async function revertChange(
  ledger: Ledger,
  id: string,
  connector: Connector | undefined,
  ctx: RevertContext,
  now = new Date(),
): Promise<RevertOutcome> {
  const entry = ledger.get(id);
  if (!entry) return { ok: false, message: `There is no change with the id "${id}". Run the ledger command to see the ids.` };
  if (entry.kind === 'revert') return { ok: false, refused: true, message: 'That entry is an undo, and it cannot be undone. Deliver the article again instead.' };
  if (entry.status === 'reverted') return { ok: true, message: `Already undone${entry.revertedBy ? ` (see ${entry.revertedBy})` : ''}.` };
  // A pending undo is checked again below: the connector notices an undo that is still open, or one that has since been approved.
  if (!entry.reversible || !entry.handle) return { ok: false, refused: true, message: entry.notReversibleBecause ?? 'This change cannot be undone from here.' };
  if (!connector?.revert) return { ok: false, refused: true, message: 'The client has no connector that can undo changes, so nothing was changed.' };
  if (connector.type !== entry.connector) {
    return { ok: false, refused: true, message: `This change was made through ${entry.connector}, but the client's connector is now ${connector.type}. Nothing was changed.` };
  }

  let result;
  try {
    result = await connector.revert(entry.handle, ctx);
  } catch (e) {
    const message = `The undo failed and nothing is known to have changed: ${e instanceof Error ? e.message : String(e)}`;
    entry.status = 'revert_failed';
    entry.note = message;
    return { ok: false, message };
  }
  if (result.refused) return { ok: false, refused: true, message: result.note };
  if (!result.ok) {
    entry.status = 'revert_failed';
    entry.note = result.note;
    return { ok: false, message: result.note };
  }

  const fields = {
    at: now.toISOString(),
    summary: result.pending ? `Undo of "${entry.title}" prepared; waiting for approval.` : `Undid "${entry.title}".`,
    ...(result.url ? { url: result.url } : {}),
    status: (result.pending ? 'revert_pending' : 'applied') as LedgerEntry['status'],
    note: result.note,
  };
  // Checking a pending undo again updates the same undo entry instead of adding a second one.
  const earlier = entry.revertedBy ? ledger.get(entry.revertedBy) : undefined;
  const undo = earlier
    ? Object.assign(earlier, fields)
    : ledger.add(
        {
          kind: 'revert',
          slug: entry.slug,
          title: entry.title,
          connector: entry.connector,
          reversible: false,
          notReversibleBecause: 'An undo cannot itself be undone. Deliver the article again instead.',
          reverts: entry.id,
          ...fields,
        },
        now,
      );
  entry.status = result.pending ? 'revert_pending' : 'reverted';
  entry.revertedBy = undo.id;
  return { ok: true, ...(result.pending ? { pending: true } : {}), message: result.note, ...(result.url ? { url: result.url } : {}) };
}
