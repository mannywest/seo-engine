import type { ClientProfile, Draft } from '../types.js';

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[mock\]\s*/g, 'mock-')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

/** Turns a draft into a markdown file (with YAML front matter) ready for a site's content folder. */
export function toMarkdownFile(
  draft: Draft,
  profile: ClientProfile,
  date = new Date(),
): { path: string; slug: string; content: string } {
  const slug = draft.topic.slug || slugify(draft.title);
  const status = profile.publish.mode === 'auto' ? 'published' : 'draft';
  const front = [
    '---',
    `title: ${JSON.stringify(draft.title)}`,
    `description: ${JSON.stringify(draft.description)}`,
    `pubDate: ${date.toISOString().slice(0, 10)}`,
    `tags: ${JSON.stringify(draft.tags)}`,
    `status: ${status}`,
    'reviewed: false',
    'generatedBy: seo-engine',
    `sources: ${JSON.stringify(draft.sources.map((s) => ({ title: s.title, url: s.url })))}`,
    '---',
    '',
  ].join('\n');
  return {
    slug,
    path: `${profile.publish.contentDir.replace(/\/$/, '')}/${slug}.md`,
    content: `${front}${draft.body.trim()}\n`,
  };
}
