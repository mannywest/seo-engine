export interface OnPageInput {
  title: string;
  description: string;
  slug: string;
  keyword: string;
  body: string;
}

export interface OnPageResult {
  /** Blocking problems. */
  issues: string[];
  /** Advice that should not block publishing. */
  warnings: string[];
  stats: { words: number; readingEase: number; avgSentenceWords: number; keywordDensity: number };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const stripped = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  return Math.max(1, stripped.match(/[aeiouy]{1,2}/g)?.length ?? 1);
}

/** Flesch reading ease: higher is easier. Roughly 60-70 is plain English. */
export function readingEase(text: string): { score: number; avgSentenceWords: number } {
  const sentences = text.split(/[.!?]+\s/).filter((s) => s.trim().length > 0);
  const words = text.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (!sentences.length || !words.length) return { score: 0, avgSentenceWords: 0 };
  const syll = words.reduce((n, w) => n + countSyllables(w), 0);
  const avgSentenceWords = words.length / sentences.length;
  const score = 206.835 - 1.015 * avgSentenceWords - 84.6 * (syll / words.length);
  return { score: Math.round(score), avgSentenceWords: Math.round(avgSentenceWords * 10) / 10 };
}

function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>]/g, '');
}

export function analyseArticle(input: OnPageInput): OnPageResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  const plain = stripMarkdown(input.body);
  const words = plain.split(/\s+/).filter(Boolean);
  const kw = norm(input.keyword);

  // Keyword placement
  const first100 = norm(words.slice(0, 100).join(' '));
  const h2s = [...input.body.matchAll(/^##\s+(.+)$/gm)].map((m) => norm(m[1] ?? ''));
  let keywordDensity = 0;
  if (kw && !/^(\[mock\]|mock )/i.test(input.title)) {
    const kwWords = kw.split(' ');
    if (!norm(input.title).includes(kw)) warnings.push(`Target keyword "${input.keyword}" is not in the title.`);
    if (!kwWords.every((w) => norm(input.slug.replace(/-/g, ' ')).includes(w))) warnings.push('Target keyword is not reflected in the URL slug.');
    if (!norm(input.description).includes(kw)) warnings.push('Target keyword is not in the meta description.');
    if (!first100.includes(kw)) warnings.push('Target keyword does not appear in the first 100 words.');
    if (!h2s.some((h) => h.includes(kw) || kwWords.filter((w) => h.includes(w)).length >= Math.ceil(kwWords.length / 2))) {
      warnings.push('No section heading relates to the target keyword.');
    }
    const occurrences = kw ? norm(plain).split(kw).length - 1 : 0;
    keywordDensity = words.length ? (occurrences * kwWords.length) / words.length : 0;
    // Density is only meaningful on a reasonably long article.
    if (words.length >= 300 && keywordDensity > 0.03) warnings.push(`Keyword density is ${(keywordDensity * 100).toFixed(1)}%, which reads as stuffing. Keep it under 3%.`);
  }

  // Structure
  if (/^#\s+\S/m.test(input.body)) issues.push('Body contains an H1 (#). The page template supplies the H1; use ## for sections.');
  const levels = [...input.body.matchAll(/^(#{2,6})\s/gm)].map((m) => (m[1] ?? '').length);
  for (let i = 1; i < levels.length; i++) {
    if ((levels[i] ?? 0) - (levels[i - 1] ?? 0) > 1) {
      warnings.push('Heading levels skip (for example ## to ####).');
      break;
    }
  }
  for (const m of input.body.matchAll(/!\[([^\]]*)\]\(([^)]*)\)/g)) {
    if (!(m[1] ?? '').trim()) issues.push(`Image "${m[2]}" has no alt text.`);
  }

  // Links
  const links = [...input.body.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)];
  const external = links.filter((m) => /^https?:\/\//.test(m[2] ?? ''));
  if (external.length === 0) warnings.push('No outbound links to sources. Citing authoritative pages helps readers and trust.');
  for (const m of links) {
    if (/^(click here|here|read more|link|this)$/i.test((m[1] ?? '').trim())) warnings.push(`Weak link text "${m[1]}". Use descriptive anchor text.`);
  }

  // Readability
  const { score, avgSentenceWords } = readingEase(plain);
  if (words.length > 100) {
    if (score < 40) warnings.push(`Hard to read (Flesch ${score}). Use shorter sentences and simpler words.`);
    if (avgSentenceWords > 25) warnings.push(`Sentences average ${avgSentenceWords} words; aim for under 20.`);
  }
  const longParas = input.body.split(/\n\s*\n/).filter((p) => !/^#/.test(p.trim()) && p.split(/\s+/).length > 120).length;
  if (longParas) warnings.push(`${longParas} paragraph(s) over 120 words. Break them up.`);

  return { issues, warnings, stats: { words: words.length, readingEase: score, avgSentenceWords, keywordDensity } };
}
