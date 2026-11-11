/**
 * The shape of one article in the inbox. Mirrors InboxItem in the engine (src/inbox.ts) and the
 * inbox_items table (supabase/schema.sql); keep the three in step. `clientId` is added here because the
 * web app reads rows straight from the table.
 */
export const INBOX_STATUS = ['waiting', 'approved', 'rejected', 'published', 'publish_failed'] as const;
export type InboxStatus = (typeof INBOX_STATUS)[number];

export interface InboxItem {
  clientId: string;
  id: string;
  addedAt: string;
  status: InboxStatus;
  reason: string;
  title: string;
  description: string;
  tags: string[];
  body: string;
  topic: { title: string; slug: string; keyword: string; intent: string; outline: string[] };
  sources: { title: string; url: string }[];
  quality: { passed: boolean; score: number; issues: string[]; warnings: string[] };
  decidedAt?: string;
  decidedBy?: string;
  note?: string;
  edited?: boolean;
  deliveredTo?: string;
  deliveryNote?: string;
  ledgerId?: string;
}
