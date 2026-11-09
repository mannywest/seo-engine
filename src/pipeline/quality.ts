import type { ClientProfile, Draft, QualityReport } from '../types.js';

export interface QualityOptions {
  /** Skip the word-count check (used for mock drafts only). */
  skipLength?: boolean;
  existingSlugs?: string[];
}

const FIGURE = /(?:[£$€]\s?\d[\d,.]*\s?(?:k|m|bn)?|\d+(?:\.\d+)?\s?%)/gi;

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

/**
 * Deterministic checks that run before any human sees a draft. A draft passes only with zero issues.
 * These do not prove an article is good; they catch the failures that are cheap to catch automatically.
 */
export function checkDraft(
  draft: Draft,
  profile: ClientProfile,
  opts: QualityOptions = {},
): QualityReport {
  const issues: string[] = [];
  const body = draft.body;
  const lower = body.toLowerCase();

  if (!opts.skipLength) {
    const words = wordCount(body);
    if (words < profile.wordRange.min) issues.push(`Too short: ${words} words (min ${profile.wordRange.min}).`);
    if (words > profile.wordRange.max) issues.push(`Too long: ${words} words (max ${profile.wordRange.max}).`);
  }

  if (draft.title.length > 65) issues.push(`Title is ${draft.title.length} characters (max 65).`);
  const d = draft.description.length;
  if (d < 70 || d > 160) issues.push(`Meta description is ${d} characters (should be 70-160).`);

  const h2s = body.match(/^##\s+\S/gm)?.length ?? 0;
  if (h2s < 3) issues.push(`Only ${h2s} section headings (need at least 3).`);
  if (!/^##\s+(frequently asked questions|faq)/im.test(body)) issues.push('Missing a FAQ section.');

  const links = [...body.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? '');
  const internal = links.filter((u) => u.startsWith('/') || u.startsWith(profile.siteUrl));
  if (internal.length < profile.minInternalLinks) {
    issues.push(`Only ${internal.length} internal links (need ${profile.minInternalLinks}).`);
  }

  for (const phrase of profile.bannedClaims) {
    if (lower.includes(phrase.toLowerCase())) issues.push(`Contains banned claim: "${phrase}".`);
  }

  // Any statistic or money figure must appear in a source snippet, otherwise it may be invented.
  const sourceText = normalise(draft.sources.map((s) => `${s.title} ${s.snippet}`).join(' '));
  for (const fig of new Set(body.match(FIGURE) ?? [])) {
    if (!sourceText.includes(normalise(fig))) issues.push(`Figure "${fig}" is not supported by any source.`);
  }

  if (opts.existingSlugs?.includes(draft.topic.slug)) {
    issues.push(`An article with slug "${draft.topic.slug}" already exists.`);
  }

  return { passed: issues.length === 0, score: Math.max(0, 100 - issues.length * 15), issues };
}
