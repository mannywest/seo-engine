import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Connector, PublishItem } from './connectors/types.js';
import { recordDelivery, type Ledger } from './ledger.js';
import { toMarkdownFile } from './publish/markdown.js';
import type { ClientProfile, Draft, QualityReport } from './types.js';

/**
 * The approval inbox: every article that needs a person's say-so waits here with its checks and sources,
 * and only leaves the engine once someone approves it. The screen people tap on (a web app) reads and writes
 * the same items; this file holds the rules, so the rules are the same whatever the screen is.
 */
export const INBOX_STATUS = ['waiting', 'approved', 'rejected', 'published', 'publish_failed'] as const;
export type InboxStatus = (typeof INBOX_STATUS)[number];

const ItemSchema = z.object({
  /** The article's slug. */
  id: z.string().min(1),
  addedAt: z.string(),
  status: z.enum(INBOX_STATUS),
  /** Why it is here, in plain English. */
  reason: z.string(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  body: z.string(),
  topic: z.object({ title: z.string(), slug: z.string(), keyword: z.string(), intent: z.string(), outline: z.array(z.string()) }),
  sources: z.array(z.object({ title: z.string(), url: z.string() })),
  quality: z.object({ passed: z.boolean(), score: z.number(), issues: z.array(z.string()), warnings: z.array(z.string()) }),
  decidedAt: z.string().optional(),
  decidedBy: z.string().optional(),
  note: z.string().optional(),
  /** True when a person changed the text before approving. */
  edited: z.boolean().optional(),
  deliveredTo: z.string().optional(),
  deliveryNote: z.string().optional(),
  /** The change-ledger entry made when it was delivered, so it can be taken back. */
  ledgerId: z.string().optional(),
});
export type InboxItem = z.infer<typeof ItemSchema>;

/** Where inbox items are kept. A local file today; a hosted database later. Same rules either way. */
export interface InboxStore {
  list(): Promise<InboxItem[]>;
  get(id: string): Promise<InboxItem | undefined>;
  /** Adds or replaces an item and saves it. */
  put(item: InboxItem): Promise<void>;
}

/** Items kept in data/<client>/inbox.json. A missing file is an empty inbox; a file that exists but is invalid is an error. */
export class FileInboxStore implements InboxStore {
  private constructor(
    private items: InboxItem[],
    private path: string,
  ) {}

  static async load(clientId: string, dataDir = 'data'): Promise<FileInboxStore> {
    const path = join(dataDir, clientId, 'inbox.json');
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new FileInboxStore([], path);
      throw e;
    }
    const parsed = z.array(ItemSchema).safeParse(JSON.parse(raw));
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new Error(`${path} is not a valid approval inbox: ${first?.path.join('.') ?? ''} ${first?.message ?? ''}`.trim());
    }
    return new FileInboxStore(parsed.data, path);
  }

  async list() {
    return this.items.map((i) => ({ ...i }));
  }
  async get(id: string) {
    const i = this.items.find((x) => x.id === id);
    return i ? { ...i } : undefined;
  }
  async put(item: InboxItem) {
    const n = this.items.findIndex((x) => x.id === item.id);
    if (n === -1) this.items.push(item);
    else this.items[n] = item;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.items, null, 2) + '\n', 'utf8');
  }
}

/** Builds an inbox item from a finished draft and its automatic checks. */
export function itemFromDraft(
  draft: Draft,
  quality: QualityReport,
  o: { status: InboxStatus; reason: string; deliveredTo?: string; deliveryNote?: string; now?: Date },
): InboxItem {
  return {
    id: draft.topic.slug,
    addedAt: (o.now ?? new Date()).toISOString(),
    status: o.status,
    reason: o.reason,
    title: draft.title,
    description: draft.description,
    tags: draft.tags,
    body: draft.body,
    topic: draft.topic,
    sources: draft.sources.map((s) => ({ title: s.title, url: s.url })),
    quality: { passed: quality.passed, score: quality.score, issues: quality.issues, warnings: quality.warnings },
    ...(o.deliveredTo ? { deliveredTo: o.deliveredTo } : {}),
    ...(o.deliveryNote ? { deliveryNote: o.deliveryNote } : {}),
  };
}

/** The plain-English reason a draft is waiting. */
export function waitingReason(quality: QualityReport): string {
  return quality.passed
    ? 'Ready for your approval.'
    : `Needs a look first: ${quality.issues.length} problem${quality.issues.length === 1 ? '' : 's'} found by the automatic checks.`;
}

export interface Decision {
  /** Who decided (a name or email), kept for the record. */
  by: string;
  note?: string;
  /** A corrected body of text. Only used when approving. */
  editedBody?: string;
  now?: Date;
}

export class InboxError extends Error {}

/** Approve or reject one item. Nothing is published here; approved items go out when publishApproved runs. */
export async function decide(store: InboxStore, id: string, action: 'approve' | 'reject', d: Decision): Promise<InboxItem> {
  const item = await store.get(id);
  if (!item) throw new InboxError(`There is nothing in the inbox with the id "${id}".`);
  if (item.status === 'published') {
    throw new InboxError('That article is already published. To take it back, use the ledger.');
  }
  if (action === 'reject' && item.status === 'rejected') return item;
  if (action === 'approve' && (item.status === 'approved' || item.status === 'publish_failed') && d.editedBody === undefined) return item;
  if (action === 'approve' && d.editedBody !== undefined && !d.editedBody.trim()) {
    throw new InboxError('The edited text is empty, so nothing was approved.');
  }
  const next: InboxItem = {
    ...item,
    status: action === 'approve' ? 'approved' : 'rejected',
    decidedAt: (d.now ?? new Date()).toISOString(),
    decidedBy: d.by,
    ...(d.note ? { note: d.note } : {}),
    ...(action === 'approve' && d.editedBody !== undefined && d.editedBody !== item.body ? { body: d.editedBody, edited: true } : {}),
  };
  await store.put(next);
  return next;
}

export interface PublishOutcome {
  id: string;
  ok: boolean;
  note: string;
  url?: string;
}

/**
 * Sends every approved article (and any whose last attempt failed) through the client's connector, live,
 * because a person has approved it. Each delivery is recorded in the change ledger so it can be taken back.
 * A failure leaves the item approved-but-failed so the next run tries again; it never loses the article.
 */
export async function publishApproved(
  store: InboxStore,
  profile: ClientProfile,
  connector: Connector,
  ledger?: Ledger,
  now = new Date(),
): Promise<PublishOutcome[]> {
  const out: PublishOutcome[] = [];
  const todo = (await store.list()).filter((i) => i.status === 'approved' || i.status === 'publish_failed');
  const live: ClientProfile = { ...profile, publish: { ...profile.publish, mode: 'auto' } };
  for (const item of todo) {
    const draft: Draft = {
      topic: item.topic,
      title: item.title,
      description: item.description,
      body: item.body,
      tags: item.tags,
      sources: item.sources.map((s) => ({ ...s, snippet: '' })),
    };
    const file = toMarkdownFile(draft, live, now);
    const pub: PublishItem = {
      slug: file.slug,
      title: item.title,
      description: item.description,
      tags: item.tags,
      body: item.body.trim(),
      markdown: file.content,
    };
    try {
      const [r] = await connector.publish([pub], { clientId: profile.id, clientName: profile.name, mode: 'auto' });
      if (r?.ok) {
        const entry = ledger ? recordDelivery(ledger, connector, { slug: file.slug, title: item.title }, r, { mode: 'auto' }, now) : undefined;
        await store.put({
          ...item,
          status: 'published',
          deliveredTo: r.url ?? connector.type,
          ...(r.note ? { deliveryNote: r.note } : {}),
          ...(entry ? { ledgerId: entry.id } : {}),
        });
        out.push({ id: item.id, ok: true, note: r.note ?? 'Published.', ...(r.url ? { url: r.url } : {}) });
        continue;
      }
      const note = r?.note ?? 'The connector did not accept the article.';
      await store.put({ ...item, status: 'publish_failed', deliveryNote: note });
      out.push({ id: item.id, ok: false, note });
    } catch (e) {
      const note = `Delivery failed: ${e instanceof Error ? e.message : String(e)}`;
      await store.put({ ...item, status: 'publish_failed', deliveryNote: note });
      out.push({ id: item.id, ok: false, note });
    }
  }
  return out;
}
