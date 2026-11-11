import { readFile } from 'node:fs/promises';
import { createConnector } from './connectors/index.js';
import { MeteredProvider, UsageLog } from './usage.js';
import { articlesRemaining } from './plans.js';
import { FactsVault } from './facts.js';
import { History } from './history.js';
import { openInbox } from './inboxOpen.js';
import { Ledger } from './ledger.js';
import { runPipeline, type RunResult } from './pipeline/run.js';
import { crawlSite } from './seo/crawl.js';
import { MockProvider, type LlmProvider } from './providers/llm.js';
import { MockSearch, type SearchProvider } from './providers/search.js';
import { chooseLlm, type LlmChoice } from './providers/choose.js';
import { CompositeSearch, CrawlSources, FileSources } from './providers/sources.js';
import type { ClientProfile } from './types.js';

export async function loadProfile(path: string): Promise<ClientProfile> {
  const profile = JSON.parse(await readFile(path, 'utf8')) as ClientProfile;
  if (profile.connector) createConnector(profile.connector); // throws a clear error if the connector config is wrong
  return profile;
}

export interface RunClientOptions {
  live: boolean;
  llm: LlmChoice;
  sourcesDir?: string;
  crawl?: boolean;
  count: number;
  outDir?: string;
  /** Deliver passing drafts through the client's connector. */
  publish?: boolean;
  dataDir?: string;
  llmProvider?: LlmProvider;
}

/** One client, one run: the same steps whether you start it by hand or the scheduler does. */
export async function runClient(profile: ClientProfile, o: RunClientOptions): Promise<RunResult[]> {
  const outDir = o.outDir ?? `out/${profile.id}`;
  let llm: LlmProvider;
  let search: SearchProvider;
  if (!o.live) {
    llm = new MockProvider();
    search = new MockSearch();
  } else {
    llm = o.llmProvider ?? chooseLlm(o.llm);
    const providers: SearchProvider[] = [new FileSources(o.sourcesDir ?? `clients/${profile.id}/sources`)];
    if (o.crawl) providers.push(new CrawlSources(await crawlSite(profile.siteUrl, undefined, { maxPages: 60 })));
    search = new CompositeSearch(providers);
  }
  const history = o.live ? await History.load(profile.id, o.dataDir) : undefined;
  // Live runs always use the answer guard. A client with no facts file yet has an empty vault, so unconfirmed claims about the business are held for review.
  const vault = o.live ? await FactsVault.load(profile.id, o.dataDir) : undefined;
  const ledger = o.live ? await Ledger.load(profile.id, o.dataDir) : undefined;
  const inbox = o.live && profile.publish.inbox ? await openInbox(profile.id, o.dataDir ? { dataDir: o.dataDir } : {}) : undefined;
  const connector = o.publish && profile.connector ? createConnector(profile.connector) : undefined;
  if (o.publish && !profile.connector) throw new Error(`${profile.id}: no "connector" in the client file, so there is nowhere to deliver articles.`);
  const usage = o.live ? await UsageLog.load(profile.id, o.dataDir) : undefined;
  if (usage) llm = new MeteredProvider(llm, usage, { monthlyTokenCap: profile.llmTokenCapPerMonth });
  let count = o.count;
  if (history) {
    const month = new Date().toISOString().slice(0, 7);
    const used = history.entries.filter((e) => e.createdAt.startsWith(month)).length;
    count = Math.min(count, articlesRemaining(profile.plan, used));
  }
  if (count <= 0) return [];
  try {
    return await runPipeline(profile, llm, search, { count, outDir, mock: !o.live, history, connector, vault, ledger, inbox });
  } finally {
    await history?.save();
    await usage?.save();
    await ledger?.save();
  }
}
