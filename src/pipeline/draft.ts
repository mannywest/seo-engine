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
    'Start with a direct, answer-first paragraph. Use ## headings, end with a "## Frequently asked questions" section.',
    `Include at least ${profile.minInternalLinks} links to these pages, using relative URLs: ${profile.internalLinks
      .map((l) => `${l.label} (${l.url})`)
      .join('; ')}.`,
    'Use ONLY facts found in the provided sources. Do not invent statistics, clients, quotes or results.',
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
