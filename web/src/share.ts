import type { InboxItem } from './types';

/**
 * The copy / download fallback for sites that cannot be connected (Squarespace, Webflow and others with no way for us to post):
 * an approved article as plain markdown, so the owner can paste it into their site themselves.
 */
export function articleMarkdown(i: Pick<InboxItem, 'title' | 'description' | 'tags' | 'body'>): string {
  const q = (s: string) => JSON.stringify(s);
  return ['---', `title: ${q(i.title)}`, `description: ${q(i.description)}`, ...(i.tags.length ? [`tags: [${i.tags.map(q).join(', ')}]`] : []), '---', '', i.body.trim(), ''].join('\n');
}

/** A safe file name for the download: the article's slug, lower case, letters, numbers and dashes only. */
export function articleFileName(i: Pick<InboxItem, 'id'> & { topic: { slug: string } }): string {
  const base = (i.topic.slug || i.id).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${base || 'article'}.md`;
}

/** Only approved articles can be taken away: approving is the person's say-so, and it must come first. */
export function canTakeAway(status: InboxItem['status']): boolean {
  return status === 'approved' || status === 'published' || status === 'publish_failed';
}
