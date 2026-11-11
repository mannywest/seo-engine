import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Connector, PublishItem } from '../connectors/types.js';
import type { FactsVault } from '../facts.js';
import type { History } from '../history.js';
import { itemFromDraft, waitingReason, type InboxStore } from '../inbox.js';
import { recordDelivery, type Ledger } from '../ledger.js';
import type { LlmProvider } from '../providers/llm.js';
import type { SearchProvider } from '../providers/search.js';
import type { ClientProfile, QualityReport } from '../types.js';
import { buildProof, renderProof, renderSources } from '../proof.js';
import { toMarkdownFile } from '../publish/markdown.js';
import { writeDraft } from './draft.js';
import { improveReadability } from './readability.js';
import { repairFigures, unsupportedFigures } from './repair.js';
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
  /** If set, every delivery that goes through is recorded so it can be taken back. */
  ledger?: Ledger;
  /** If set (live runs only), drafts that need a person wait here instead of being delivered. */
  inbox?: InboxStore;
}

export interface RunResult {
  slug: string;
  path: string;
  quality: QualityReport;
  deliveredTo?: string;
  deliveryNote?: string;
  /** True when the draft is waiting in the approval inbox. */
  waitingForApproval?: boolean;
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
    const written = await writeDraft(profile, topic, sources, llm, opts.vault);
    // Live runs only: one optional plain-English rewrite when the article is hard to read.
    let draft = opts.mock ? written : await improveReadability(written, llm);
    const checkOpts = { skipLength: opts.mock, existingSlugs: slugs, vault: opts.vault };
    let quality = checkDraft(draft, profile, checkOpts);
    // Live runs only: if figures lack a source, one repair pass tries to take them out. Kept only if it clearly helps.
    const unsupported = opts.mock ? [] : unsupportedFigures(quality.issues);
    if (unsupported.length) {
      const repaired = await repairFigures(draft, unsupported, llm);
      if (repaired !== draft) {
        const again = checkDraft(repaired, profile, checkOpts);
        if (again.issues.length < quality.issues.length) {
          draft = repaired;
          quality = again;
        }
      }
    }
    const file = toMarkdownFile(draft, profile);
    const path = join(opts.outDir, `${file.slug}.md`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, 'utf8');
    // Proof packs live beside the articles folder so they never get mistaken for articles.
    const proofDir = `${opts.outDir.replace(/[\\/]+$/, '')}.proofs`;
    await mkdir(proofDir, { recursive: true });
    await writeFile(join(proofDir, `${file.slug}.proof.md`), renderProof(buildProof(draft, quality, profile, llm.name)), 'utf8');
    // The text the engine read from each source, beside the articles, for tracing wrong facts.
    const sourcesDir = `${opts.outDir.replace(/[\\/]+$/, '')}.sources`;
    await mkdir(sourcesDir, { recursive: true });
    await writeFile(join(sourcesDir, `${file.slug}.sources.md`), renderSources(draft), 'utf8');
    slugs.push(file.slug);
    const result: RunResult = { slug: file.slug, path, quality };

    // With an approval inbox, anything that needs a person (review mode, or failed checks) waits there instead of leaving the engine.
    const needsApproval = !!opts.inbox && !opts.mock && (profile.publish.mode === 'review' || !quality.passed);
    if (needsApproval && opts.inbox) {
      await opts.inbox.put(itemFromDraft(draft, quality, { status: 'waiting', reason: waitingReason(quality) }));
      result.waitingForApproval = true;
      result.deliveryNote = 'Waiting in the approval inbox.';
    } else if (opts.connector && quality.passed && !opts.mock) {
      // Only drafts that pass the automatic checks leave the engine. The rest stay local for a human to look at.
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
        if (r?.ok && opts.ledger) recordDelivery(opts.ledger, opts.connector, { slug: file.slug, title: draft.title }, r, { mode: profile.publish.mode });
        if (r?.ok && opts.inbox) {
          await opts.inbox.put(itemFromDraft(draft, quality, { status: 'published', reason: 'Published automatically.', deliveredTo: result.deliveredTo, deliveryNote: result.deliveryNote }));
        }
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
