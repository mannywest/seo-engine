import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createConnector } from './connectors/index.js';
import { History } from './history.js';
import { buildReceipt } from './receipt.js';
import { UsageLog } from './usage.js';
import { notify } from './notify.js';
import { chooseLlm } from './providers/choose.js';
import { loadProfile, runClient } from './runClient.js';
import { fetchGscQueries } from './seo/gscApi.js';
import { onboardSite } from './seo/onboard.js';
import { renderSpeed, runPageSpeed } from './seo/pagespeed.js';
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

const USAGE = `seo-engine commands (all free to run except --llm anthropic):

  onboard <site-url> [--id NAME] [--llm ollama|gemini|groq|...] [--repo owner/name] [--webhook-url URL]
      Set up a new client from their website address. Reads the site, detects the platform,
      writes clients/<id>.json and says which connector to use.

  check <client.json>
      Test that a client is ready: config valid, connector credentials work. Publishes nothing.

  run <client.json> [--mock | --live] [--llm anthropic|ollama|gemini|groq|openrouter|openai-compatible] [--model NAME]
                    [--sources DIR] [--crawl] [--count N] [--out DIR] [--publish]
      Plan, research, draft, check and write articles. --mock costs nothing and writes placeholders.
      Sources: your notes in DIR (default clients/<id>/sources) and, with --crawl, the client's own site.
      --publish delivers articles that pass the checks through the client's connector.

  receipt <client.json> [--month YYYY-MM]
      Print the plain-English monthly work receipt for a client.

  run-all [--llm gemini|...] [--dry]
      What the scheduler runs: every clients/*.json that is due (by its articles-per-week setting),
      one failure never stops the others, failures are alerted. Needs --live-style setup (an AI key).

  speed <url> [--desktop]
      Core Web Vitals through Google PageSpeed Insights (free).

  gsc-api <client.json> --property "sc-domain:example.com"
      Live Search Console data (free) using a service account, then the same opportunity report as gsc.

  audit <url> [--max N] [--out report.md]
      Crawl a site and report technical, on-page, structured-data and AI-search problems.

  gsc <Queries.csv>
      Find opportunities in a Google Search Console export.

  site <client.json> --content DIR --out DIR [--block-all]
      Build sitemap.xml, robots.txt, llms.txt, rss.xml and JSON-LD for published articles, plus a strategy report.
`;

async function cmdRun(profilePath: string) {
  const profile = await loadProfile(profilePath);
  const live = flag('live');
  if (!live) console.log('MOCK MODE: no AI calls, no cost. Output is placeholder text.\n');
  const results = await runClient(profile, {
    live,
    llm: { llm: arg('llm', 'anthropic')!, model: arg('model'), baseUrl: arg('base-url') },
    sourcesDir: arg('sources'),
    crawl: flag('crawl'),
    count: Number(arg('count', '2')),
    outDir: arg('out'),
    publish: flag('publish'),
  });
  if (!results.length) console.log('No new drafts written: the planned topics already exist. (In live mode, also check there are notes in the sources folder or use --crawl.)');
  for (const r of results) {
    console.log(`${r.quality.passed ? 'PASS' : 'REVIEW'}  ${r.path}  (score ${r.quality.score})`);
    for (const i of r.quality.issues) console.log(`   - ${i}`);
    for (const w of r.quality.warnings) console.log(`   ~ ${w}`);
    if (r.deliveredTo) console.log(`   delivered: ${r.deliveredTo}${r.deliveryNote ? ` (${r.deliveryNote})` : ''}`);
    else if (r.deliveryNote) console.log(`   ${r.deliveryNote}`);
  }
}

async function cmdRunAll() {
  const files = (await readdir('clients')).filter((f) => f.endsWith('.json')).sort();
  const failures: string[] = [];
  const dry = flag('dry');
  for (const f of files) {
    try {
      const profile = await loadProfile(join('clients', f));
      const history = await History.load(profile.id);
      if (!history.isDue(profile.publish.cadencePerWeek)) {
        console.log(`skip  ${profile.id}: not due yet`);
        continue;
      }
      if (dry) {
        console.log(`due   ${profile.id}`);
        continue;
      }
      const results = await runClient(profile, {
        live: true,
        llm: { llm: arg('llm', process.env.SEO_LLM ?? 'gemini')!, model: arg('model', process.env.SEO_MODEL), baseUrl: arg('base-url') },
        crawl: true,
        count: 1,
        publish: !!profile.connector,
      });
      for (const r of results) {
        console.log(`${r.quality.passed ? 'PASS' : 'REVIEW'}  ${profile.id}/${r.slug}${r.deliveredTo ? `  -> ${r.deliveredTo}` : ''}`);
        if (r.deliveryNote?.startsWith('Delivery failed')) failures.push(`${profile.id}: ${r.deliveryNote}`);
      }
    } catch (e) {
      const msg = `${f}: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`FAIL  ${msg}`);
      failures.push(msg);
    }
  }
  if (failures.length) {
    await notify(`seo-engine: ${failures.length} problem(s)\n${failures.map((x) => `- ${x}`).join('\n')}`);
    process.exitCode = 1;
  }
}

async function cmdOnboard(url: string) {
  const llmName = arg('llm');
  const r = await onboardSite(url, { id: arg('id'), llm: llmName ? chooseLlm({ llm: llmName, model: arg('model') }) : undefined });
  const repo = arg('repo');
  const hook = arg('webhook-url');
  const profile = r.profile;
  if (repo) profile.connector = { type: 'git', repo, baseBranch: 'main', contentDir: profile.publish.contentDir, tokenEnv: 'GITHUB_TOKEN' };
  else if (hook) profile.connector = { type: 'webhook', url: hook, secretEnv: `WEBHOOK_SECRET_${profile.id.toUpperCase().replace(/-/g, '_')}` };
  else if (r.advice.connector === 'wordpress') {
    const k = profile.id.toUpperCase().replace(/-/g, '_');
    profile.connector = { type: 'wordpress', siteUrl: profile.siteUrl, userEnv: `WP_USER_${k}`, passwordEnv: `WP_APP_PASSWORD_${k}` };
  }
  const path = `clients/${profile.id}.json`;
  await mkdir('clients', { recursive: true });
  await writeFile(path, JSON.stringify(profile, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${path}`);
  console.log(`Platform detected: ${r.platform}. Suggested connector: ${r.advice.connector}. ${r.advice.why}`);
  if (!profile.connector) console.log(`No connector set yet. Re-run with ${r.advice.connector === 'git' ? '--repo owner/name' : '--webhook-url https://...'} or edit the file.`);
  console.log('\nBefore the first run:');
  for (const line of r.review) console.log(`  - ${line}`);
}

async function cmdCheck(profilePath: string) {
  const profile = await loadProfile(profilePath);
  const problems: string[] = [];
  if (!profile.keywords.length) problems.push('No keywords in the client file.');
  if (!profile.connector) problems.push('No connector: articles can be written but not delivered.');
  else problems.push(...(await createConnector(profile.connector).check()));
  if (problems.length) {
    console.log(`${profile.id}: ${problems.length} thing(s) to fix`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  } else console.log(`${profile.id}: ready`);
}

async function cmdSpeed(url: string) {
  console.log(renderSpeed(await runPageSpeed(url, flag('desktop') ? 'desktop' : 'mobile')));
}

async function cmdGscApi(profilePath: string) {
  const profile = await loadProfile(profilePath);
  const property = arg('property', `${profile.siteUrl}/`)!;
  const rows = await fetchGscQueries(property);
  const o = findOpportunities(rows);
  console.log(`${rows.length} queries from Search Console for ${property}`);
  const show = (title: string, list: typeof o.strikingDistance) => {
    console.log(`\n${title}`);
    for (const r of list.slice(0, 15)) console.log(`  ${r.query}  (impr ${r.impressions}, pos ${r.position.toFixed(1)})`);
    if (!list.length) console.log('  none');
  };
  show('Striking distance:', o.strikingDistance);
  show('Low click-through:', o.lowCtr);
  show('Content gaps:', o.contentGaps);
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

/** GitHub Actions can hand us every repository secret as one JSON blob, so adding a client's key never needs a workflow edit. */
function loadSecretsBlob() {
  const blob = process.env.SECRETS_JSON;
  if (!blob) return;
  try {
    for (const [k, v] of Object.entries(JSON.parse(blob) as Record<string, string>)) if (process.env[k] === undefined) process.env[k] = v;
  } catch {
    /* ignore a malformed blob */
  }
}

async function cmdReceipt(target: string) {
  const profile = await loadProfile(target);
  const month = arg('month') ?? new Date().toISOString().slice(0, 7);
  const history = await History.load(profile.id);
  const usage = await UsageLog.load(profile.id);
  console.log(buildReceipt({ clientName: profile.name, month, plan: profile.plan, history: history.entries, usage: usage.forMonth(month) }));
}

async function main() {
  loadSecretsBlob();
  const [cmd, target] = process.argv.slice(2);
  if (cmd === 'run-all') return cmdRunAll();
  if (!cmd || !target) {
    console.log(USAGE);
    process.exit(1);
  }
  if (cmd === 'run') await cmdRun(target);
  else if (cmd === 'onboard') await cmdOnboard(target);
  else if (cmd === 'check') await cmdCheck(target);
  else if (cmd === 'speed') await cmdSpeed(target);
  else if (cmd === 'gsc-api') await cmdGscApi(target);
  else if (cmd === 'audit') await cmdAudit(target);
  else if (cmd === 'gsc') await cmdGsc(target);
  else if (cmd === 'site') await cmdSite(target);
  else if (cmd === 'receipt') await cmdReceipt(target);
  else {
    console.log(USAGE);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
