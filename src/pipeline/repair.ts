import { z } from 'zod';
import type { LlmProvider } from '../providers/llm.js';
import type { Draft } from '../types.js';
import { askForJson } from './askJson.js';
import { figuresOf, headings, linksOf, words } from './readability.js';

const Repaired = z.object({ body: z.string().min(20) });

/** Pulls the figures out of quality issues like: Figure "80%" is not supported by any source. */
export function unsupportedFigures(issues: string[]): string[] {
  return issues.flatMap((i) => {
    const m = /^Figure "(.+)" is not supported by any source\.$/.exec(i);
    return m?.[1] ? [m[1]] : [];
  });
}

/** True when the repair removed every listed figure, added none, and kept the links, headings and most of the text. */
export function acceptableRepair(before: string, after: string, figures: string[]): boolean {
  if (figures.some((f) => after.includes(f))) return false;
  const old = figuresOf(before);
  if ([...figuresOf(after)].some((f) => !old.has(f))) return false;
  const kept = new Set(linksOf(after));
  if (!linksOf(before).every((l) => kept.has(l))) return false;
  if (headings(after) < headings(before)) return false;
  return words(after) >= words(before) * 0.85;
}

/**
 * One targeted fix: ask the AI to rewrite only the sentences containing figures that no source supports,
 * so they make the same point without the figure. The original is returned unchanged if the fix is not clean.
 */
export async function repairFigures(draft: Draft, figures: string[], llm: LlmProvider): Promise<Draft> {
  try {
    const { body } = await askForJson(
      llm,
      {
        task: 'draft',
        system: [
          `You are a careful editor. These figures in the article are not supported by any source: ${figures.join(', ')}.`,
          'Rewrite only the sentences that contain them so they make the same point without any figure, or delete the sentence if it adds nothing.',
          'Change nothing else: keep every other sentence, number, link and heading exactly as written. Add no new facts or figures.',
          'Reply with JSON only: {"body": "<the whole article as markdown>"}.',
        ].join('\n'),
        prompt: draft.body,
        maxTokens: 4000,
      },
      Repaired,
      'figure repair',
    );
    return acceptableRepair(draft.body, body, figures) ? { ...draft, body } : draft;
  } catch {
    return draft; // a failed repair must never lose the article
  }
}
