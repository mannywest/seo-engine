import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LlmProvider } from '../providers/llm.js';
import type { SearchProvider } from '../providers/search.js';
import type { ClientProfile, QualityReport } from '../types.js';
import { toMarkdownFile } from '../publish/markdown.js';
import { writeDraft } from './draft.js';
import { planTopics } from './plan.js';
import { checkDraft } from './quality.js';
import { gatherSources } from './research.js';

export interface RunOptions {
  count: number;
  outDir: string;
  mock: boolean;
}

export interface RunResult {
  slug: string;
  path: string;
  quality: QualityReport;
}

async function existingSlugs(outDir: string): Promise<string[]> {
  try {
    return (await readdir(outDir)).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

/** Plan -> research -> draft -> quality check -> write markdown. Failed drafts are written too, flagged for review. */
export async function runPipeline(
  profile: ClientProfile,
  llm: LlmProvider,
  search: SearchProvider,
  opts: RunOptions,
): Promise<RunResult[]> {
  const slugs = await existingSlugs(opts.outDir);
  const topics = await planTopics(profile, llm, slugs, opts.count);
  const results: RunResult[] = [];
  for (const topic of topics) {
    const sources = await gatherSources(topic, search);
    const draft = await writeDraft(profile, topic, sources, llm);
    const quality = checkDraft(draft, profile, { skipLength: opts.mock, existingSlugs: slugs });
    const file = toMarkdownFile(draft, profile);
    const path = join(opts.outDir, `${file.slug}.md`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, 'utf8');
    slugs.push(file.slug);
    results.push({ slug: file.slug, path, quality });
  }
  return results;
}
