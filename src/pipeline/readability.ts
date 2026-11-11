import type { LlmProvider } from '../providers/llm.js';
import { readingEase } from '../seo/onpage.js';
import type { Draft } from '../types.js';
import { askForJson } from './askJson.js';
import { z } from 'zod';

const Rewrite = z.object({ body: z.string().min(20) });

export const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const plain = (md: string) =>
  md.replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^#{1,6}\s+/gm, '').replace(/[*_`>]/g, '');
export const linksOf = (md: string) => [...md.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? '');
export const headings = (md: string) => (md.match(/^#{2,3}\s+.+$/gm) ?? []).length;

/** Money amounts and percentages in a text. */
export const figuresOf = (t: string) => new Set(t.match(/[£$€]\s?\d[\d,.]*|\d+(?:\.\d+)?\s?%/g) ?? []);

/** True when a rewrite is clearly easier to read and has lost nothing important. */
export function acceptableRewrite(before: string, after: string, minGain = 5): boolean {
  if (readingEase(plain(after)).score < readingEase(plain(before)).score + minGain) return false;
  if (words(after) < words(before) * 0.7) return false;
  const kept = new Set(linksOf(after));
  if (!linksOf(before).every((l) => kept.has(l))) return false;
  if (headings(after) < headings(before)) return false;
  const afterFigs = figuresOf(after);
  for (const f of figuresOf(before)) if (!afterFigs.has(f)) return false;
  for (const f of afterFigs) if (!figuresOf(before).has(f)) return false;
  return true;
}

/**
 * One optional pass: if the article is hard to read, ask the AI to rewrite it in plain English without
 * changing any fact. The rewrite is used only if it is clearly easier and nothing was lost; otherwise the
 * original stays. Costs one extra AI call, and only when the article needs it.
 */
export async function improveReadability(draft: Draft, llm: LlmProvider, threshold = 40): Promise<Draft> {
  if (readingEase(plain(draft.body)).score >= threshold) return draft;
  try {
    const { body } = await askForJson(
      llm,
      {
        task: 'draft',
        system: [
          'You are an editor. Rewrite the article body in plain British English: short sentences (mostly under 20 words), everyday words.',
          'Keep every fact, number, percentage, link, heading and the FAQ section exactly as they are. Add no new facts, claims or examples.',
          'Reply with JSON only: {"body": "<markdown>"}.',
        ].join('\n'),
        prompt: draft.body,
        maxTokens: 4000,
      },
      Rewrite,
      'readability rewrite',
    );
    return acceptableRewrite(draft.body, body) ? { ...draft, body } : draft;
  } catch {
    return draft; // a failed rewrite must never lose the article
  }
}
