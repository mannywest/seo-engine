import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createConnector } from './connectors/index.js';
import { ConnectionError, withConnection } from './connections.js';
import { FACT_KINDS, FactsVault, type FactKind } from './facts.js';
import { History } from './history.js';
import { decide, InboxError, publishApproved, type InboxStore } from './inbox.js';
import { InboxConfigError, inboxClientFiles, openInbox } from './inboxOpen.js';
import { Ledger, revertChange } from './ledger.js';
import { buildReceipt } from './receipt.js';
import { UsageLog } from './usage.js';
import { notify } from './notify.js';
import { chooseLlm } from './providers/choose.js';
import { describeError } from './retry.js';
import { loadProfile, runClient } from './runClient.js';
import { fetchGscQueries } from './seo/gscApi.js';
import { onboardSite } from './seo/onboard.js';
import { renderSpeed, runPageSpeed } from './seo/pagespeed.js';
import { parseArticle } from './publish/frontmatter.js';
import { buildSiteArtifacts } from './publish/site.js';
import { auditSite } from './seo/audit.js';
import { assessSafety, renderSafetyReport } from './seo/safety.js';
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

  run <client.json> [--mock | --live] [--llm anthropic|ollama|gemini|groq|openrouter|openai-compatible] [--model NAME] [--fallback groq,openrouter]
                    [--sources DIR] [--crawl] [--count N] [--out DIR] [--publish]
      Plan, research, draft, check and write articles. --mock costs nothing and writes placeholders.
      Sources: your notes in DIR (default clients/<id>/sources) and, with --crawl, the client's own site.
      --publish delivers articles that pass the checks through the client's connector.

  receipt <client.json> [--month YYYY-MM]
      Print the plain-English monthly work receipt for a client.

  facts <client.json> [--add KIND --label TEXT --value TEXT] [--remove ID]
      List, add or remove the client's confirmed business facts (hours, prices, services, areas, contact,
      credentials, guarantees, policies). Articles may only state these about the business. Adding a fact
      marks it as confirmed today, so only add what the business has actually told you.
      KIND is one of: ${FACT_KINDS.join(', ')}. Write times like 8am-6pm so the guard can read them.

  ledger <client.json> [--revert ID [--force]]
      List every change the engine has made to the client's site. --revert ID takes one back safely:
      it refuses if the page has been edited since, and nothing is ever deleted (files are moved aside,
      WordPress posts go to the trash, GitHub changes become a pull request). --force undoes it anyway.
      Needs the same access (environment variables) as publishing. Articles sent by webhook cannot be taken back from here.

  publish-approved [client-id]
      Publishes every approved article waiting in the approval inbox, for one client or all clients with the inbox on. Safe to run any time; nothing is published twice.
  inbox <client.json> [list | show ID | approve ID | reject ID | publish] [--by NAME] [--note TEXT] [--edit-file PATH] [--publish]
      The approval inbox. Drafts that need a person wait here (turn it on with "inbox": true under "publish" in the client file).
      approve marks one ready (--edit-file replaces the text with your corrected version; --publish sends it straight away).
      publish sends every approved article live through the client's connector and records it in the ledger.

  run-all [--llm gemini|...] [--dry]
      What the scheduler runs: every clients/*.json that is due (by its articles-per-week setting),
      one failure never stops the others, failures are alerted. Needs --live-style setup (an AI key).

  speed <url> [--desktop]
      Core Web Vitals through Google PageSpeed Insights (free).

  gsc-api <client.json> --property "sc-domain:example.com"
      Live Search Console data (free) using a service account, then the same opportunity report as gsc.

  audit <url> [--max N] [--out report.md]
  safety <url> [--max N] [--out report.md]   site safety score and rescue plan (thin, near-copy, padded, spammy pages)
      Crawl a site and report technical, on-page, structured-data and AI-search problems.

  gsc <Queries.csv>
      Find opportunities in a Google Search Console export.

  site <client.json> --content DIR --out DIR [--block-all]
      Build sitemap.xml, robots.txt, llms.txt, rss.xml and JSON-LD for published articles, plus a strategy report.
`;

/** Backup AIs from --fallback groq,openrouter or the SEO_FALLBACK setting. */
function fallbackList(): string[] | undefined {
  const v = arg('fallback', process.env.SEO_FALLBACK);
  return v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
}

async function cmdRun(profilePath: string) {
  const profile = await loadProfile(profilePath);
  const live = flag('live');
  if (!live) console.log('MOCK MODE: no AI calls, no cost. Output is placeholder text.\n');
  const results = await runClient(profile, {
    live,
    llm: { llm: arg('llm', 'anthropic')!, model: arg('model'), baseUrl: arg('base-url'), fallback: fallbackList() },
    sourcesDir: arg('sources'),
    crawl: flag('crawl'),
    count: Number(arg('count', '2')),
    outDir: arg('out'),
    publish: flag('publish'),
  });
  if (!results.length) console.log('No new drafts written: the planned topics already exist. (In live mode, also check there are notes in the sources folder or use --crawl.)');
  for (const r of results) {
    console.log(`${r.quality.passed ? 'PASS' : 'REVIEW'}  ${r.path}  (score ${r.quality.score})${r.waitingForApproval ? '  [in the approval inbox]' : ''}`);
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
      // A saved connection (from the Connect screen) beats the client file. If it needs attention, drafts still reach the inbox.
      const profile = await withConnection(await loadProfile(join('clients', f)), { strict: false });
      const history = await History.open(profile.id);
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
        llm: { llm: arg('llm', process.env.SEO_LLM ?? 'gemini')!, model: arg('model', process.env.SEO_MODEL), baseUrl: arg('base-url'), fallback: fallbackList() },
        crawl: true,
        count: 1,
        publish: !!profile.connector,
      });
      for (const r of results) {
        console.log(`${r.quality.passed ? 'PASS' : 'REVIEW'}  ${profile.id}/${r.slug}${r.deliveredTo ? `  -> ${r.deliveredTo}` : ''}`);
        if (r.deliveryNote?.startsWith('Delivery failed')) failures.push(`${profile.id}: ${r.deliveryNote}`);
      }
    } catch (e) {
      const msg = `${f}: ${describeError(e)}`;
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
  let profile = await loadProfile(profilePath);
  const problems: string[] = [];
  try {
    profile = await withConnection(profile);
  } catch (e) {
    if (!(e instanceof ConnectionError)) throw e;
    problems.push(e.message);
    const { connector: _left, ...rest } = profile;
    profile = rest as ClientProfile;
  }
  if (!profile.keywords.length) problems.push('No keywords in the client file.');
  if (!profile.connector) {
    if (!problems.length) problems.push('No connector: articles can be written but not delivered.');
  } else problems.push(...(await createConnector(profile.connector).check()));
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

async function cmdSafety(url: string) {
  const site = await crawlSite(url, undefined, { maxPages: Number(arg('max', '100')) });
  const report = renderSafetyReport(assessSafety(site));
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
  const history = await History.open(profile.id);
  const usage = await UsageLog.open(profile.id);
  console.log(buildReceipt({ clientName: profile.name, month, plan: profile.plan, history: history.entries, usage: usage.forMonth(month) }));
}

async function cmdFacts(target: string) {
  const profile = await loadProfile(target);
  const vault = await FactsVault.open(profile.id);
  const add = arg('add');
  const remove = arg('remove');
  if (add) {
    const label = arg('label');
    const value = arg('value');
    if (!(FACT_KINDS as readonly string[]).includes(add) || !label || !value) {
      console.log(`To add a fact: facts ${target} --add <${FACT_KINDS.join('|')}> --label "Opening hours" --value "Mon-Fri 8am-6pm"`);
      process.exit(1);
    }
    const f = vault.upsert({ kind: add as FactKind, label, value });
    await vault.save();
    console.log(`Saved: ${f.label}: ${f.value} (marked as confirmed ${f.verifiedAt})\n`);
  } else if (remove) {
    if (!vault.remove(remove)) {
      console.log(`No fact with id "${remove}". Ids are shown in the list below.`);
      process.exit(1);
    }
    await vault.save();
    console.log(`Removed ${remove}.\n`);
  }
  if (vault.isEmpty) {
    console.log(`${profile.name}: no confirmed business facts yet. Until there are some, articles that state hours, prices, contact details, areas, credentials or guarantees are held for review.`);
    return;
  }
  console.log(`${profile.name}: ${vault.facts.length} confirmed business fact${vault.facts.length === 1 ? '' : 's'}`);
  for (const f of vault.facts) console.log(`  [${f.kind}] ${f.label}: ${f.value}  (confirmed ${f.verifiedAt})  id: ${f.id}`);
  const stale = vault.stale();
  if (stale.length) console.log(`\n${stale.length} fact(s) are over 6 months old and should be re-confirmed: ${stale.map((f) => f.label).join(', ')}.`);
}

const LEDGER_STATUS = { applied: 'done', reverted: 'undone', revert_pending: 'undo waiting for approval', revert_failed: 'undo failed' } as const;

async function cmdLedger(target: string) {
  const profile = await withConnection(await loadProfile(target), { strict: !!arg('revert') });
  const ledger = await Ledger.open(profile.id);
  const id = arg('revert');
  if (id) {
    const connector = profile.connector ? createConnector(profile.connector) : undefined;
    const out = await revertChange(ledger, id, connector, { mode: profile.publish.mode, clientName: profile.name, force: flag('force') });
    await ledger.save();
    console.log(`${out.message}${out.url ? `\n${out.url}` : ''}\n`);
    if (!out.ok) process.exitCode = 1;
  }
  if (!ledger.entries.length) {
    console.log(`${profile.name}: no changes recorded yet.`);
    return;
  }
  console.log(`${profile.name}: ${ledger.entries.length} recorded change${ledger.entries.length === 1 ? '' : 's'}`);
  for (const e of ledger.entries) {
    const undo = e.kind === 'publish' && e.status === 'applied' ? (e.reversible ? '  can be undone' : '  cannot be undone from here') : '';
    console.log(`  ${e.at.slice(0, 16).replace('T', ' ')}  [${LEDGER_STATUS[e.status]}]  ${e.summary}${undo}\n      id: ${e.id}`);
  }
}

const INBOX_LABEL = { waiting: 'waiting', approved: 'approved', rejected: 'rejected', published: 'published', publish_failed: 'approved, delivery failed' } as const;

/** Sends one client's approved articles out through its connector and records them in the change ledger. */
async function publishFor(fileProfile: ClientProfile, store: InboxStore) {
  let profile: ClientProfile;
  try {
    profile = await withConnection(fileProfile);
  } catch (e) {
    if (e instanceof ConnectionError) throw new InboxError(e.message);
    throw e;
  }
  if (!profile.connector) throw new InboxError('This client has no connector, so there is nowhere to publish to.');
  const ledger = await Ledger.open(profile.id);
  const results = await publishApproved(store, profile, createConnector(profile.connector), ledger);
  await ledger.save();
  if (!results.length) console.log(`${profile.name}: nothing approved is waiting to be published.`);
  for (const r of results) console.log(`${r.ok ? 'published' : 'FAILED   '}  ${r.id}  ${r.note}${r.url ? `  ${r.url}` : ''}`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

/** One client or all clients with the inbox on. A problem with one client never stops the others. */
async function cmdPublishApproved(only?: string) {
  try {
    const files = await inboxClientFiles('clients', only);
    if (!files.length) return console.log('No client has the approval inbox switched on.');
    for (const f of files) {
      try {
        const profile = await loadProfile(f);
        await publishFor(profile, await openInbox(profile.id));
      } catch (e) {
        console.error(`${f}: ${e instanceof Error ? e.message : e}`);
        process.exitCode = 1;
      }
    }
  } catch (e) {
    if (!(e instanceof InboxConfigError)) throw e;
    console.log(e.message);
    process.exitCode = 1;
  }
}

async function cmdInbox(target: string) {
  const profile = await loadProfile(target);
  const store = await openInbox(profile.id);
  const sub = process.argv[4] ?? 'list';
  const id = process.argv[5];
  const publish = () => publishFor(profile, store);
  try {
    if (sub === 'list') {
      const items = await store.list();
      if (!items.length) return console.log(`${profile.name}: the inbox is empty.`);
      for (const i of items) console.log(`[${INBOX_LABEL[i.status]}]  ${i.id}  "${i.title}"  (score ${i.quality.score})  ${i.reason}`);
    } else if (sub === 'show') {
      const i = id ? await store.get(id) : undefined;
      if (!i) throw new InboxError(`Give the id of an article in the inbox. Run "inbox ${target} list" to see them.`);
      console.log(`${i.title}\n[${INBOX_LABEL[i.status]}] ${i.reason}\n`);
      for (const x of i.quality.issues) console.log(`  problem: ${x}`);
      for (const x of i.quality.warnings) console.log(`  note: ${x}`);
      console.log(`\nSources:\n${i.sources.map((s) => `  ${s.title} (${s.url})`).join('\n') || '  none'}\n\n${i.body}`);
    } else if (sub === 'approve' || sub === 'reject') {
      if (!id) throw new InboxError(`Give the id of an article, for example: inbox ${target} ${sub} my-article`);
      const edit = arg('edit-file');
      const item = await decide(store, id, sub, {
        by: arg('by', process.env.USER ?? 'operator')!,
        note: arg('note'),
        ...(edit && sub === 'approve' ? { editedBody: await readFile(edit, 'utf8') } : {}),
      });
      console.log(`${item.id}: ${INBOX_LABEL[item.status]}${item.edited && item.status !== 'rejected' ? ' (text edited)' : ''}.`);
      if (sub === 'approve' && flag('publish')) await publish();
    } else if (sub === 'publish') await publish();
    else console.log(USAGE);
  } catch (e) {
    if (!(e instanceof InboxError || e instanceof InboxConfigError)) throw e;
    console.log(e.message);
    process.exitCode = 1;
  }
}

async function main() {
  loadSecretsBlob();
  const [cmd, target] = process.argv.slice(2);
  if (cmd === 'run-all') return cmdRunAll();
  if (cmd === 'publish-approved') return cmdPublishApproved(target);
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
  else if (cmd === 'safety') await cmdSafety(target);
  else if (cmd === 'gsc') await cmdGsc(target);
  else if (cmd === 'site') await cmdSite(target);
  else if (cmd === 'receipt') await cmdReceipt(target);
  else if (cmd === 'facts') await cmdFacts(target);
  else if (cmd === 'ledger') await cmdLedger(target);
  else if (cmd === 'inbox') await cmdInbox(target);
  else {
    console.log(USAGE);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(describeError(e));
  process.exit(1);
});
