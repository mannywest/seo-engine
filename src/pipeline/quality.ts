import type { FactsVault } from '../facts.js';
import { guardDraft } from '../guard.js';
import type { ClientProfile, Draft, QualityReport } from '../types.js';
import { analyseArticle } from '../seo/onpage.js';
import { sentences, tokens } from '../seo/text.js';

export interface QualityOptions {
  /** Skip the word-count check (used for mock drafts only). */
  skipLength?: boolean;
  existingSlugs?: string[];
  /** The client's confirmed business facts. When given, the answer guard runs and the vault counts as a source for figures. */
  vault?: FactsVault;
  now?: Date;
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

  // The business's own confirmed facts count as a source, so a price taken from the vault is not flagged as invented.
  const sources = opts.vault && !opts.vault.isEmpty ? [...draft.sources, opts.vault.asSource()] : draft.sources;

  // Any statistic or money figure must appear in the source text, otherwise it may be invented.
  const sourceText = normalise(sources.map((s) => `${s.title} ${s.fullText ?? s.snippet}`).join(' '));
  // The pattern can swallow a trailing full stop or line break ("£79.\n"), so trim them before comparing.
  for (const fig of new Set((body.match(FIGURE) ?? []).map((f) => f.replace(/[\s.,]+$/, '')))) {
    if (!sourceText.includes(normalise(fig))) issues.push(`Figure "${fig}" is not supported by any source.`);
  }

  if (opts.existingSlugs?.includes(draft.topic.slug)) {
    issues.push(`An article with slug "${draft.topic.slug}" already exists.`);
  }

  const noAlt = [...body.matchAll(/!\[([^\]]*)\]\(/g)].filter((m) => !(m[1] ?? '').trim()).length;
  if (noAlt) issues.push(`${noAlt} image(s) have no alt text (hurts accessibility and image search).`);

  const onPage = analyseArticle({
    title: draft.title,
    description: draft.description,
    slug: draft.topic.slug,
    keyword: draft.topic.keyword,
    body,
  });
  issues.push(...onPage.issues);

  // The answer guard: nothing stated about the business itself may go beyond what the business has confirmed.
  const guard = opts.vault ? guardDraft(body, opts.vault, { businessName: profile.name, now: opts.now }) : undefined;
  if (guard) issues.push(...guard.issues);
  const warnings = [...onPage.warnings, ...unsupportedClaims({ ...draft, sources }), ...(guard?.warnings ?? [])];

  return {
    passed: issues.length === 0,
    score: Math.max(0, 100 - issues.length * 15 - warnings.length * 3),
    issues,
    warnings,
    ...(guard ? { factsUsed: guard.factsUsed.map((f) => ({ label: f.label, value: f.value, verifiedAt: f.verifiedAt })) } : {}),
  };
}

/**
 * Free claim check: sentences that contain a number must share most of their meaningful words with one source
 * snippet. Not proof, but it catches invented specifics without an extra AI call.
 */
export function unsupportedClaims(draft: Draft): string[] {
  const plain = draft.body
    .replace(/^#{1,6}\s.*$/gm, ' ')
    .replace(/^\s*(?:\d+[.)]|[-*+])\s+/gm, '') // list markers like "1." are not figures
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>]/g, '');
  const sourceTokens = draft.sources.map((s) => new Set(tokens(`${s.title} ${s.fullText ?? s.snippet}`)));
  const out: string[] = [];
  for (const s of sentences(plain)) {
    if (!/\d/.test(s)) continue;
    if (s.endsWith(':')) continue; // a lead-in to a list is not a claim
    const t = tokens(s).filter((w) => !/^\d+$/.test(w));
    if (t.length < 4) continue;
    const best = Math.max(0, ...sourceTokens.map((set) => t.filter((w) => set.has(w)).length / t.length));
    if (best < 0.4) out.push(`Claim may be unsupported by the sources: "${s.slice(0, 90)}${s.length > 90 ? '...' : ''}"`);
    if (out.length === 5) break;
  }
  return out;
}
