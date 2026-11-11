import { z } from 'zod';
import type { LlmProvider } from '../providers/llm.js';
import type { ClientProfile, Topic } from '../types.js';
import { slugify } from '../publish/markdown.js';
import { jaccard, tokens } from '../seo/text.js';
import { askForJson, toList } from './askJson.js';

export { extractJson } from './askJson.js';

const PlanSchema = z.object({
  topics: z.array(
    z.object({
      title: z.string().min(5),
      keyword: z.string().min(2),
      intent: z.string(),
      outline: z.preprocess(toList, z.array(z.string()).min(3)),
    }),
  ),
});

export async function planTopics(
  profile: ClientProfile,
  llm: LlmProvider,
  existingSlugs: string[],
  count: number,
): Promise<Topic[]> {
  const system =
    'You plan SEO and AI-search article topics for a business website. ' +
    'Reply with JSON only: {"topics":[{"title","keyword","intent","outline"}]}. ' +
    'Titles must be under 65 characters, specific, and useful to the audience. Never invent facts.';
  const prompt = [
    `COUNT=${count}`,
    `Business: ${profile.name} (${profile.siteUrl})`,
    `About: ${profile.description}`,
    `Audience: ${profile.audience}`,
    `Services: ${profile.services.join('; ')}`,
    `Seed keywords: ${profile.keywords.join('; ')}`,
    `Do not repeat these existing topics (slugs): ${existingSlugs.join(', ') || 'none'}`,
  ].join('\n');

  const parsed = await askForJson(llm, { task: 'plan', system, prompt, maxTokens: 1500 }, PlanSchema, 'topic plan');
  const seen = new Set(existingSlugs);
  const topics: Topic[] = [];
  for (const t of parsed.topics) {
    const slug = slugify(t.title);
    if (!slug || seen.has(slug)) continue;
    // Skip topics that would compete with an existing article for the same search (keyword cannibalisation).
    const tt = tokens(t.title);
    if ([...seen].some((s) => jaccard(tokens(s.replace(/-/g, ' ')), tt) >= 0.7)) continue;
    seen.add(slug);
    topics.push({ ...t, slug });
    if (topics.length === count) break;
  }
  return topics;
}
