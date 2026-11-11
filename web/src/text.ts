import type { InboxItem } from './types';

export type Block =
  | { type: 'h2' | 'h3' | 'p'; text: string }
  | { type: 'ul' | 'ol'; items: string[] };

/**
 * Splits an article's markdown into simple blocks for display. It only ever produces plain text,
 * so nothing in an article (even a stray <script>) can run on the page.
 */
export function parseBody(body: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | undefined;
  const flushPara = () => {
    if (para.length) blocks.push({ type: 'p', text: para.join(' ') });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = undefined;
  };
  for (const raw of body.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (!line) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      blocks.push({ type: (heading[1] as string).length <= 2 ? 'h2' : 'h3', text: heading[2] as string });
    } else if (bullet || numbered) {
      flushPara();
      const type = bullet ? 'ul' : 'ol';
      if (list && list.type !== type) flushList();
      list ??= { type, items: [] };
      list.items.push(((bullet ?? numbered) as RegExpExecArray)[1] as string);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return blocks;
}

/** Only web links are made clickable. Anything else (javascript:, data:, ...) stays plain text. */
export function safeUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function wordCount(body: string): number {
  return body.trim() ? body.trim().split(/\s+/).length : 0;
}

export type Tab = 'needs' | 'way' | 'done';
export const TABS: { id: Tab; label: string }[] = [
  { id: 'needs', label: 'Needs you' },
  { id: 'way', label: 'On its way' },
  { id: 'done', label: 'Done' },
];

export function tabOf(item: InboxItem): Tab {
  if (item.status === 'waiting') return 'needs';
  if (item.status === 'approved' || item.status === 'publish_failed') return 'way';
  return 'done';
}

/** Items for one tab: what needs you first (oldest waiting first), the rest newest first. */
export function itemsFor(items: InboxItem[], tab: Tab): InboxItem[] {
  const hit = items.filter((i) => tabOf(i) === tab);
  return hit.sort((a, b) => (tab === 'needs' ? a.addedAt.localeCompare(b.addedAt) : (b.decidedAt ?? b.addedAt).localeCompare(a.decidedAt ?? a.addedAt)));
}

export const STATUS_LABEL: Record<InboxItem['status'], string> = {
  waiting: 'Waiting for you',
  approved: 'Approved, publishes on the next run',
  publish_failed: 'Approved, delivery failed, will retry',
  rejected: 'Rejected',
  published: 'Published',
};

export function timeAgo(iso: string, now = new Date()): string {
  const mins = Math.floor((now.getTime() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins) || mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function scoreTone(item: InboxItem): 'good' | 'warn' | 'bad' {
  if (!item.quality.passed) return 'bad';
  return item.quality.warnings.length ? 'warn' : 'good';
}
