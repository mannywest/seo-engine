import { ZodError, type ZodTypeDef, type ZodType } from 'zod';
import type { LlmProvider, LlmRequest } from '../providers/llm.js';

/** Finds the JSON object in an AI reply, even if the AI wrapped it in code fences or a sentence. */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Model reply contained no JSON object.');
  return JSON.parse(text.slice(start, end + 1));
}

const bullet = /^\s*(?:[-*•]|\d+[.)])\s*/;
const clean = (s: string) => s.replace(bullet, '').trim();

/**
 * AIs often send a list as one block of text ("1. A\n2. B" or "A, B, C") when asked for an array.
 * This turns that text into a list. Anything that is not text is passed through unchanged.
 */
export function toList(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const text = v.trim();
  const strategies: ((t: string) => string[])[] = [
    (t) => t.split(/\r?\n/),
    (t) => t.split(/\s+(?=\d+[.)]\s)/), // "1. A 2. B 3. C" on one line
    (t) => t.split(/\s*[|;]\s*/),
    (t) => t.split(/\s*,\s*/),
  ];
  for (const split of strategies) {
    const parts = split(text).map(clean).filter(Boolean);
    if (parts.length >= 2) return parts;
  }
  return text ? [clean(text)] : [];
}

/** A short plain description of what was wrong with an AI reply. */
export function describeProblem(e: unknown): string {
  if (e instanceof ZodError) return e.issues.map((i) => `${i.path.join('.') || 'reply'}: ${i.message}`).join('; ');
  return e instanceof Error ? e.message : String(e);
}

/**
 * Asks the AI for JSON and checks it against the expected shape. If the reply cannot be used, the AI is
 * told exactly what was wrong and asked once more (like handing a form back with the mistake circled).
 * Errors from the AI service itself (busy, wrong key, spend cap) are not caught here: they pass straight up.
 */
export async function askForJson<T>(
  llm: LlmProvider,
  req: LlmRequest,
  schema: ZodType<T, ZodTypeDef, unknown>,
  what: string,
  attempts = 2,
): Promise<T> {
  let prompt = req.prompt;
  for (let i = 1; ; i++) {
    const raw = await llm.complete({ ...req, prompt });
    try {
      return schema.parse(extractJson(raw));
    } catch (e) {
      const problem = describeProblem(e);
      if (i >= attempts) throw new Error(`The AI's ${what} was not in the expected format after ${attempts} tries: ${problem}`);
      prompt = `${req.prompt}\n\nYour previous reply could not be used: ${problem}\nReply again with JSON only, in exactly the format described, using real lists (arrays) where a list is asked for.`;
    }
  }
}
