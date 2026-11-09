import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AnthropicProvider, MockProvider, type LlmProvider } from './providers/llm.js';
import { OllamaProvider } from './providers/ollama.js';
import { MockSearch, type SearchProvider } from './providers/search.js';
import { CompositeSearch, CrawlSources, FileSources } from './providers/sources.js';
import { runPipeline } from './pipeline/run.js';
import { parseArticle } from './publish/frontmatter.js';
import { buildSiteArtifacts } from './publish/site.js';
import { auditSite } from './seo/audit.js';
import { crawlSite } from './seo/crawl.js';
import { findOpportunities, parseGscCsv } from './seo/gsc.js';
import { renderAuditReport } from './seo/report.js';
import type { ClientProfile } from './types.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const loadProfile = async (p: string) => JSON.parse(await readFile(p, 'utf8')) as ClientProfile;

const USAGE = `seo-engine commands (all free to run except --llm anthropic):

  run <client.json> [--mock | --live] [--llm anthropic|ollama] [--model NAME]
                    [--sources DIR] [--crawl] [--count N] [--out DIR]
      Plan, research, draft, check and write articles. --mock costs nothing and writes placeholders.
      Sources: your notes in DIR (default clients/<id>/sources) and, with --crawl, the client's own site.

  audit <url> [--max N] [--out report.md]
      Crawl a site and report technical, on-page, structured-data and AI-search problems.

  gsc <Queries.csv>
      Find opportunities in a Google Search Console export.

  site <client.json> --content DIR --out DIR [--block-all]
      Build sitemap.xml, robots.txt, llms.txt, rss.xml and JSON-LD for published articles, plus a strategy report.
`;

async function cmdRun(profilePath: string) {
  const profile = await loadProfile(profilePath);
  const count = Number(arg('count', '2'));
  const outDir = arg('out', `out/${profile.id}`)!;
  const mock = !flag('live');
  let llm: LlmProvider;
  let search: SearchProvider;

  if (mock) {
    llm = new MockProvider();
    search = new MockSearch();
    console.log('MOCK MODE: no AI calls, no cost. Output is placeholder text.\n');
  } else {
    if (arg('llm', 'anthropic') === 'ollama') {
      llm = new OllamaProvider(arg('model', 'llama3.1'));
    } else {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error('--llm anthropic needs ANTHROPIC_API_KEY (this spends money). Use --llm ollama for a free local model.');
      llm = new AnthropicProvider(key);
    }
    const providers: SearchProvider[] = [new FileSources(arg('sources', `clients/${profile.id}/sources`)!)];
    if (flag('crawl')) providers.push(new CrawlSources(await crawlSite(profile.siteUrl, undefined, { maxPages: 60 })));
    search = new CompositeSearch(providers);
  }

  const results = await runPipeline(profile, llm, search, { count, outDir, mock });
  if (!results.length) console.log('No new drafts written: the planned topics already exist in the output folder. (In live mode, also check there are notes in the sources folder or use --crawl.)');
  for (const r of results) {
    console.log(`${r.quality.passed ? 'PASS' : 'REVIEW'}  ${r.path}  (score ${r.quality.score})`);
    for (const i of r.quality.issues) console.log(`   - ${i}`);
    for (const w of r.quality.warnings) console.log(`   ~ ${w}`);
  }
}

async function cmdAudit(url: string) {
  const site = await crawlSite(url, undefined, { maxPages: Number(arg('max', '100')) });
  const report = renderAuditReport(auditSite(site));
  const out = arg('out');
  if (out) {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, report, 'utf8');
    console.log(`Report written to ${out}`);
  } else console.log(report);
}

async function cmdGsc(csvPath: string) {
  const o = findOpportunities(parseGscCsv(await readFile(csvPath, 'utf8')));
  const show = (title: string, rows: typeof o.strikingDistance) => {
    console.log(`\n${title}`);
    for (const r of rows.slice(0, 15)) console.log(`  ${r.query}  (impr ${r.impressions}, pos ${r.position.toFixed(1)}, ctr ${(r.ctr * 100).toFixed(1)}%)`);
    if (!rows.length) console.log('  none');
  };
  show('Striking distance (improve or write a stronger article):', o.strikingDistance);
  show('Low click-through (rewrite title and description):', o.lowCtr);
  show('Content gaps (no strong page yet):', o.contentGaps);
}

async function cmdSite(profilePath: string) {
  const profile = await loadProfile(profilePath);
  const content = arg('content');
  const out = arg('out');
  if (!content || !out) throw new Error('site needs --content DIR and --out DIR');
  const names = (await readdir(content)).filter((f) => f.endsWith('.md'));
  const items = [];
  for (const f of names) {
    items.push({ slug: f.replace(/\.md$/, ''), article: parseArticle(await readFile(join(content, f), 'utf8')) });
  }
  const result = buildSiteArtifacts(profile, items, { blockAll: flag('block-all') });
  for (const [path, body] of Object.entries(result.files)) {
    const full = join(out, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body, 'utf8');
  }
  console.log(`Wrote ${Object.keys(result.files).length} files to ${out}`);
  for (const line of result.report) console.log(`  ${line}`);
}

async function main() {
  const [cmd, target] = process.argv.slice(2);
  if (!cmd || !target) {
    console.log(USAGE);
    process.exit(1);
  }
  if (cmd === 'run') await cmdRun(target);
  else if (cmd === 'audit') await cmdAudit(target);
  else if (cmd === 'gsc') await cmdGsc(target);
  else if (cmd === 'site') await cmdSite(target);
  else {
    console.log(USAGE);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
