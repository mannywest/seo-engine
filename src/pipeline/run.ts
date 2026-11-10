import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Connector, PublishItem } from '../connectors/types.js';
import type { FactsVault } from '../facts.js';
import type { History } from '../history.js';
import type { LlmProvider } from '../providers/llm.js';
import type { SearchProvider } from '../providers/search.js';
import type { ClientProfile, QualityReport } from '../types.js';
import { buildProof, renderProof } from '../proof.js';
import { toMarkdownFile } from '../publish/markdown.js';
import { writeDraft } from './draft.js';
import { planTopics } from './plan.js';
import { checkDraft } from './quality.js';
import { gatherSources } from './research.js';

export interface RunOptions {
  count: number;
  outDir: string;
  mock: boolean;
  /** Memory of past runs; stops topics repeating. */
  history?: History;
  /** If set, drafts that pass the quality check are delivered to the client's site. */
  connector?: Connector;
  /** The client's confirmed business facts. When set, drafts may only state these about the business (the answer guard enforces it). */
  vault?: FactsVault;
}

export interface RunResult {
  slug: string;
  path: string;
  quality: QualityReport;
  deliveredTo?: string;
  deliveryNote?: string;
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
  const slugs = [...new Set([...(await existingSlugs(opts.outDir)), ...(opts.history?.slugs() ?? [])])];
  const topics = await planTopics(profile, llm, slugs, opts.count);
  const results: RunResult[] = [];
  for (const topic of topics) {
    const sources = await gatherSources(topic, search);
    const draft = await writeDraft(profile, topic, sources, llm, opts.vault);
    const quality = checkDraft(draft, profile, { skipLength: opts.mock, existingSlugs: slugs, vault: opts.vault });
    const file = toMarkdownFile(draft, profile);
    const path = join(opts.outDir, `${file.slug}.md`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, 'utf8');
    // Proof packs live beside the articles folder so they never get mistaken for articles.
    const proofDir = `${opts.outDir.replace(/[\\/]+$/, '')}.proofs`;
    await mkdir(proofDir, { recursive: true });
    await writeFile(join(proofDir, `${file.slug}.proof.md`), renderProof(buildProof(draft, quality, profile, llm.name)), 'utf8');
    slugs.push(file.slug);
    const result: RunResult = { slug: file.slug, path, quality };

    // Only drafts that pass the automatic checks leave the engine. The rest stay local for a human to look at.
    if (opts.connector && quality.passed && !opts.mock) {
      const item: PublishItem = {
        slug: file.slug,
        title: draft.title,
        description: draft.description,
        tags: draft.tags,
        body: draft.body.trim(),
        markdown: file.content,
      };
      try {
        const [r] = await opts.connector.publish([item], {
          clientId: profile.id,
          clientName: profile.name,
          mode: profile.publish.mode,
        });
        result.deliveredTo = r?.ok ? r.url ?? opts.connector.type : undefined;
        result.deliveryNote = r?.note;
      } catch (e) {
        result.deliveryNote = `Delivery failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    opts.history?.add({
      slug: file.slug,
      title: draft.title,
      keyword: topic.keyword,
      createdAt: new Date().toISOString(),
      passed: quality.passed,
      score: quality.score,
      deliveredTo: result.deliveredTo,
    });
    results.push(result);
  }
  return results;
}
