import { z } from 'zod';
import type { FactsVault } from '../facts.js';
import type { LlmProvider } from '../providers/llm.js';
import type { ClientProfile, Draft, Source, Topic } from '../types.js';
import { askForJson, toList } from './askJson.js';

const DraftSchema = z.object({
  title: z.string().min(5),
  description: z.string().min(20),
  body: z.string().min(20),
  tags: z.preprocess(toList, z.array(z.string())).default([]),
});

export async function writeDraft(
  profile: ClientProfile,
  topic: Topic,
  sources: Source[],
  llm: LlmProvider,
  vault?: FactsVault,
): Promise<Draft> {
  const system = [
    `You write articles for ${profile.name}. Tone: ${profile.tone}.`,
    'Reply with JSON only: {"title","description","body","tags"}. The body is markdown.',
    `Length ${profile.wordRange.min}-${profile.wordRange.max} words. Title under 65 characters; description 70-160 characters.`,
    `The description must contain the exact target keyword "${topic.keyword}", worded naturally.`,
    'Start with a direct, answer-first paragraph. Use ## headings, end with a "## Frequently asked questions" section.',
    `Include at least ${profile.minInternalLinks} links to these pages, using relative URLs: ${profile.internalLinks
      .map((l) => `${l.label} (${l.url})`)
      .join('; ')}.`,
    'Use ONLY facts found in the provided sources. Do not invent statistics, clients, quotes or results.',
    'If a source describes a demo, calculator or sample data, call it a demo or an example ("in the demo", "for example"). Never call it live, and never present it as a real client or a real result.',
    'When you quote numbers from a demo or example, copy the counts exactly as the source states them. Never work out or swap which group a number belongs to. Say which setting the demo used (for example "at the default 90% setting") and, if the source says the setting can be changed, say that changing it changes the results. If you are unsure of a number, leave it out.',
    'Write plain English a busy shop owner could follow: short sentences (mostly under 20 words), everyday words, no jargon without a quick explanation.',
    'Use British English spelling (organisation, prioritise, programme, colour).',
    `Never use these phrases: ${profile.bannedClaims.join('; ') || 'none'}.`,
    ...(vault ? [vault.promptBlock()] : []),
  ].join('\n');

  const prompt = [
    `Topic: ${topic.title}`,
    `Target keyword: ${topic.keyword}`,
    `Intent: ${topic.intent}`,
    `Outline: ${topic.outline.join(' | ')}`,
    'Sources:',
    ...sources.map((s, i) => `[${i + 1}] ${s.title} (${s.url}): ${s.snippet}`),
  ].join('\n');

  const parsed = await askForJson(llm, { task: 'draft', system, prompt, maxTokens: 4000 }, DraftSchema, 'article draft');
  return { topic, sources, ...parsed };
}
