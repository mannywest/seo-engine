import type { InboxItem } from './types';

/** Mistakes a person can make that we explain in plain English instead of failing quietly. */
export class RuleError extends Error {}

/** The same rules the database enforces (supabase/schema.sql), checked first so the message is friendly. */
export function checkApprove(item: InboxItem, editedBody?: string): void {
  if (item.status === 'published') throw new RuleError('That article is already published.');
  if (editedBody !== undefined && !editedBody.trim()) throw new RuleError('The edited text is empty, so nothing was approved.');
}

export function checkReject(item: InboxItem): void {
  if (item.status === 'published') throw new RuleError('That article is already published.');
}

/** What approving does to an item. Used by the demo; the real database does the same in its guard. */
export function approved(item: InboxItem, o: { by: string; now: Date; editedBody?: string }): InboxItem {
  checkApprove(item, o.editedBody);
  const changed = o.editedBody !== undefined && o.editedBody !== item.body;
  return {
    ...item,
    status: 'approved',
    decidedAt: o.now.toISOString(),
    decidedBy: o.by,
    ...(changed ? { body: o.editedBody as string, edited: true } : {}),
  };
}

export function rejected(item: InboxItem, o: { by: string; now: Date; note?: string }): InboxItem {
  checkReject(item);
  const note = o.note?.trim();
  return { ...item, status: 'rejected', decidedAt: o.now.toISOString(), decidedBy: o.by, ...(note ? { note } : {}) };
}
