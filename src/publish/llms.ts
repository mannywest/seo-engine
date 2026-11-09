import type { ClientProfile } from '../types.js';

export interface PublishedArticle {
  title: string;
  url: string;
  description: string;
}

/** Builds an llms.txt index (a proposed convention; no AI search engine has confirmed it uses it). */
export function buildLlmsTxt(profile: ClientProfile, articles: PublishedArticle[]): string {
  const lines = [`# ${profile.name}`, '', `> ${profile.description}`, ''];
  if (profile.internalLinks.length > 0) {
    lines.push('## Key pages', '');
    for (const l of profile.internalLinks) {
      lines.push(`- [${l.label}](${new URL(l.url, profile.siteUrl).toString()})`);
    }
    lines.push('');
  }
  if (articles.length > 0) {
    lines.push('## Articles', '');
    for (const a of articles) {
      lines.push(`- [${a.title}](${a.url}): ${a.description}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
