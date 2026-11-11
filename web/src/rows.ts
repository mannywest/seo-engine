import { INBOX_STATUS, type InboxItem, type InboxStatus } from './types';

export class RowError extends Error {}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new RowError(`${name} is missing or not text`);
  return v;
};
const strList = (v: unknown, name: string): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new RowError(`${name} is not a list of text`);
  return v as string[];
};
const obj = (v: unknown, name: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new RowError(`${name} is missing`);
  return v as Record<string, unknown>;
};
const iso = (v: string): string => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
};

/** Turns a database row into an inbox item. A row that does not fit is an error, never a guess. */
export function parseRow(row: unknown): InboxItem {
  const r = obj(row, 'row');
  const status = str(r.status, 'status');
  if (!(INBOX_STATUS as readonly string[]).includes(status)) throw new RowError(`"${status}" is not an inbox status`);
  const topic = obj(r.topic, 'topic');
  const quality = obj(r.quality, 'quality');
  if (typeof quality.passed !== 'boolean' || typeof quality.score !== 'number') throw new RowError('quality is incomplete');
  const sources = Array.isArray(r.sources) ? r.sources : [];
  const opt = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const item: InboxItem = {
    clientId: str(r.client_id, 'client_id'),
    id: str(r.id, 'id'),
    addedAt: iso(str(r.added_at, 'added_at')),
    status: status as InboxStatus,
    reason: str(r.reason, 'reason'),
    title: str(r.title, 'title'),
    description: str(r.description, 'description'),
    tags: strList(r.tags ?? [], 'tags'),
    body: str(r.body, 'body'),
    topic: {
      title: str(topic.title, 'topic.title'),
      slug: str(topic.slug, 'topic.slug'),
      keyword: str(topic.keyword, 'topic.keyword'),
      intent: str(topic.intent, 'topic.intent'),
      outline: strList(topic.outline ?? [], 'topic.outline'),
    },
    sources: sources.map((s) => {
      const o = obj(s, 'source');
      return { title: str(o.title, 'source.title'), url: str(o.url, 'source.url') };
    }),
    quality: {
      passed: quality.passed,
      score: quality.score,
      issues: strList(quality.issues ?? [], 'quality.issues'),
      warnings: strList(quality.warnings ?? [], 'quality.warnings'),
    },
  };
  const decidedAt = opt(r.decided_at);
  if (decidedAt) item.decidedAt = iso(decidedAt);
  const decidedBy = opt(r.decided_by);
  if (decidedBy) item.decidedBy = decidedBy;
  const note = opt(r.note);
  if (note) item.note = note;
  if (typeof r.edited === 'boolean') item.edited = r.edited;
  const deliveredTo = opt(r.delivered_to);
  if (deliveredTo) item.deliveredTo = deliveredTo;
  const deliveryNote = opt(r.delivery_note);
  if (deliveryNote) item.deliveryNote = deliveryNote;
  const ledgerId = opt(r.ledger_id);
  if (ledgerId) item.ledgerId = ledgerId;
  return item;
}
