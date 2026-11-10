import type { SiteSnapshot } from './crawl.js';
import type { PageData } from './html.js';
import type { Severity } from './audit.js';
import { jaccard, sentences, tokens } from './text.js';

/**
 * Site safety score and AI-content rescue audit.
 * Looks for the patterns search engines' spam policies describe: thin pages, near-copy pages (including
 * "plumber in <town>" sets), padded or repetitive text, stock AI filler wording and spammy outbound links.
 * Pure: works on a crawl, no network. It is pattern-based. It cannot know whether a page was written by AI,
 * and a clean score does not promise anything about rankings. It never changes the site; it only recommends.
 */

export type SafetyAction = 'keep' | 'rewrite' | 'merge' | 'expand' | 'prune';

export interface SafetyFinding {
  id: 'thin' | 'near-copy' | 'templated-set' | 'repetitive' | 'stuffed' | 'ai-filler' | 'spam-links' | 'link-heavy';
  severity: Severity;
  url: string;
  message: string;
  /** For near-copies: the page we suggest keeping. */
  keepUrl?: string;
}

export interface PageVerdict {
  url: string;
  action: SafetyAction;
  reasons: string[];
  keepUrl?: string;
}

export interface SafetyResult {
  origin: string;
  pagesChecked: number;
  score: number;
  band: 'safe' | 'watch' | 'at risk';
  findings: SafetyFinding[];
  verdicts: PageVerdict[];
  counts: Record<Severity, number>;
}

const WEIGHT: Record<Severity, number> = { critical: 25, high: 10, medium: 4, low: 1 };

export const THIN_WORDS = 150;
export const NEAR_COPY = 0.8;
export const TEMPLATED_SET = 3;

/** Stock phrases that show up in unedited machine-written text. A few in one page is a prompt to edit, not proof. */
export const FILLER_PHRASES = [
  "in today's fast-paced world",
  'in the ever-evolving',
  'ever-changing landscape',
  'it is important to note',
  "it's important to note",
  'in conclusion',
  'delve into',
  'unlock the power',
  'game-changer',
  'navigate the complexities',
  'look no further',
  'take your business to the next level',
  'rich tapestry',
  'testament to',
  'stands as a beacon',
  'in the realm of',
];

const SPAM_WORDS = /\b(casino|payday loan|viagra|cialis|porn|escort|online pharmacy|buy followers|replica watches?|essay writing service)\b/i;
const FOLLOWED_EXTERNAL_LIMIT = 20;

const live = (p: PageData) => p.isHtml && p.status >= 200 && p.status < 300 && !/noindex/i.test(p.robotsMeta);

export function assessSafety(site: SiteSnapshot): SafetyResult {
  const pages = [...site.pages.values()].filter(live);
  const findings: SafetyFinding[] = [];
  const add = (f: SafetyFinding) => findings.push(f);
  const words = new Map(pages.map((p) => [p.url, tokens(`${p.title} ${p.text}`)]));
  const inboundCount = (u: string) => site.inbound.get(u)?.size ?? 0;
  const weight = (p: PageData) => p.wordCount + inboundCount(p.url) * 40 + (p.url === site.startUrl ? 10_000 : 0);

  for (const p of pages) {
    const w = p.wordCount;
    if (w < THIN_WORDS) {
      add({ id: 'thin', severity: w < 50 ? 'high' : 'medium', url: p.url, message: `Only ${w} words. Very short pages add little for a visitor.` });
    }

    // Repeated sentences inside one page (padding).
    const s = sentences(p.text).filter((x) => x.length > 25).map((x) => x.toLowerCase());
    if (s.length >= 6) {
      const repeats = s.length - new Set(s).size;
      if (repeats / s.length >= 0.25) add({ id: 'repetitive', severity: 'medium', url: p.url, message: `${repeats} of ${s.length} sentences are repeats of each other (padding).` });
    }

    // One word dominating the page (keyword stuffing).
    const t = words.get(p.url) ?? [];
    if (t.length >= 100) {
      const freq = new Map<string, number>();
      for (const x of t) freq.set(x, (freq.get(x) ?? 0) + 1);
      const [top, n] = [...freq].sort((a, b) => b[1] - a[1])[0]!;
      if (n / t.length >= 0.1) add({ id: 'stuffed', severity: 'medium', url: p.url, message: `The word "${top}" makes up ${Math.round((n / t.length) * 100)}% of the page, which reads as keyword stuffing.` });
    }

    // Stock AI filler wording.
    const lower = p.text.toLowerCase();
    const hits = FILLER_PHRASES.filter((f) => lower.includes(f));
    if (hits.length >= 3) add({ id: 'ai-filler', severity: 'medium', url: p.url, message: `Uses ${hits.length} stock phrases often seen in unedited machine-written text (${hits.slice(0, 3).map((h) => `"${h}"`).join(', ')}). Worth a human rewrite in the business's own voice.` });

    // Outbound links.
    const external = p.links.filter((l) => !l.internal);
    const spammy = external.filter((l) => SPAM_WORDS.test(l.text) || SPAM_WORDS.test(l.href));
    if (spammy.length) add({ id: 'spam-links', severity: 'critical', url: p.url, message: `Links out to spam-type content (${spammy.slice(0, 2).map((l) => l.href).join(', ')}). This can be a sign the site was hacked.` });
    const followed = external.filter((l) => !l.nofollow);
    if (followed.length >= FOLLOWED_EXTERNAL_LIMIT) add({ id: 'link-heavy', severity: 'low', url: p.url, message: `${followed.length} followed links to other sites. Unusually many for one page.` });
  }

  // Near-copies: group pages whose text is almost the same.
  const parent = new Map(pages.map((p) => [p.url, p.url]));
  const find = (u: string): string => (parent.get(u) === u ? u : (parent.set(u, find(parent.get(u)!)), parent.get(u)!));
  const eligible = pages.filter((p) => p.wordCount >= 60);
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i]!;
      const b = eligible[j]!;
      if (jaccard(words.get(a.url) ?? [], words.get(b.url) ?? []) >= NEAR_COPY) parent.set(find(a.url), find(b.url));
    }
  }
  const groups = new Map<string, PageData[]>();
  for (const p of eligible) groups.set(find(p.url), [...(groups.get(find(p.url)) ?? []), p]);
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const best = [...g].sort((a, b) => weight(b) - weight(a))[0]!;
    for (const p of g) {
      if (p === best) continue;
      add(
        g.length >= TEMPLATED_SET
          ? { id: 'templated-set', severity: 'high', url: p.url, keepUrl: best.url, message: `One of ${g.length} pages that are almost the same text with a few words swapped (for example a town name). Search engines call this doorway-style content.` }
          : { id: 'near-copy', severity: 'medium', url: p.url, keepUrl: best.url, message: 'Almost the same text as another page on this site.' },
      );
    }
  }

  // Per-page verdicts.
  const verdicts: PageVerdict[] = pages.map((p) => {
    const mine = findings.filter((f) => f.url === p.url);
    const ids = new Set(mine.map((f) => f.id));
    const reasons = mine.map((f) => f.message);
    const keepUrl = mine.find((f) => f.keepUrl)?.keepUrl;
    let action: SafetyAction = 'keep';
    if (ids.has('spam-links')) action = 'rewrite';
    else if (ids.has('near-copy') || ids.has('templated-set')) action = 'merge';
    else if (ids.has('thin')) action = inboundCount(p.url) === 0 && p.url !== site.startUrl ? 'prune' : 'expand';
    else if (mine.length) action = 'rewrite';
    return { url: p.url, action, reasons, ...(keepUrl ? { keepUrl } : {}) };
  });

  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] += 1;
  // Scaled by site size so one weak page on a big site does not look like a disaster.
  const penalty = findings.reduce((n, f) => n + WEIGHT[f.severity], 0);
  const score = pages.length ? Math.max(0, Math.round(100 - (penalty / Math.max(1, pages.length)) * 4)) : 100;
  const band = counts.critical > 0 || score < 60 ? 'at risk' : score < 85 ? 'watch' : 'safe';
  return { origin: site.origin, pagesChecked: pages.length, score, band, findings, verdicts, counts };
}

const ACTION_TEXT: Record<SafetyAction, string> = {
  keep: 'Keep',
  rewrite: 'Rewrite',
  merge: 'Merge into the stronger page',
  expand: 'Expand with real detail',
  prune: 'Remove (nothing links to it)',
};

export function renderSafetyReport(r: SafetyResult): string {
  const band = { safe: 'Looks safe', watch: 'Worth watching', 'at risk': 'At risk' }[r.band];
  const lines = [
    `# Site safety check: ${r.origin}`,
    '',
    `Safety score: **${r.score}/100** (${band}) across ${r.pagesChecked} pages.`,
    '',
    'This looks for patterns that search engines treat as low-quality or spammy: very short pages, near-copy pages, padded text, stock machine-written wording and spammy links. It is a pattern check, not proof, and it does not predict rankings. Nothing on the site has been changed.',
    '',
  ];
  const todo = r.verdicts.filter((v) => v.action !== 'keep');
  if (!todo.length) lines.push('No pages need rescuing.', '');
  for (const action of ['prune', 'merge', 'rewrite', 'expand'] as SafetyAction[]) {
    const group = todo.filter((v) => v.action === action);
    if (!group.length) continue;
    lines.push(`## ${ACTION_TEXT[action]} (${group.length})`, '');
    for (const v of group.slice(0, 20)) {
      lines.push(`- ${v.url}${v.keepUrl ? ` (keep: ${v.keepUrl})` : ''}`);
      for (const why of v.reasons) lines.push(`  - ${why}`);
    }
    if (group.length > 20) lines.push(`- ...and ${group.length - 20} more`);
    lines.push('');
  }
  lines.push('Removing or merging a page should go through a 301 redirect to the page you keep, so visitors and links are not lost.', '');
  return lines.join('\n');
}
