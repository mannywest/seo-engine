# seo-engine

An automated content and SEO engine. For each client it audits the site, plans topics, researches from the client's own material, drafts articles, checks them, and produces everything a site needs to be found by Google and by AI assistants. Plerosis is the first client.

Everything runs free **except** the AI that writes the article text, and even that has a free option (a local model through Ollama).

## Commands

```bash
npm install
npm run verify                                   # typecheck + 121 tests

# Write articles (placeholder text, no cost):
npx tsx src/cli.ts run clients/plerosis.json --mock

# Write real articles from YOUR notes (free with a local model):
npx tsx src/cli.ts run clients/plerosis.json --live --llm ollama --sources clients/plerosis/sources
npx tsx src/cli.ts run clients/plerosis.json --live --llm ollama --crawl   # also use the client's own site as a source

# Paid API instead of a local model (spends money):
ANTHROPIC_API_KEY=... npx tsx src/cli.ts run clients/plerosis.json --live --llm anthropic

# Business facts vault: what the business has confirmed about itself. Articles may state
# hours, prices, contact details, areas, credentials and guarantees only if they are listed here.
# Live runs hold back any article that states something unconfirmed.
npx tsx src/cli.ts facts clients/plerosis.json
npx tsx src/cli.ts facts clients/plerosis.json --add price --label "Boiler service" --value "£79"

# Change ledger: every article the engine delivered, and a safe way to take one back.
# Undo refuses if the page was edited since, and never deletes (files move to .reverted, WordPress posts go
# to the trash, GitHub changes become a pull request). Webhook deliveries cannot be undone from here.
npx tsx src/cli.ts ledger clients/plerosis.json
npx tsx src/cli.ts ledger clients/plerosis.json --revert <id> [--force]

# Audit any site (technical, on-page, structured data, AI search):
npx tsx src/cli.ts audit https://plerosis.com --out out/audit.md

# Site safety check: thin pages, near-copy town pages, padded or stock machine-written text, spammy links.
# Recommends only (keep / rewrite / merge / expand / remove); never changes the site.
npx tsx src/cli.ts safety https://plerosis.com --out out/safety.md

# Find opportunities in a Google Search Console export (Queries.csv):
npx tsx src/cli.ts gsc ~/Downloads/Queries.csv

# Build sitemap.xml, robots.txt, llms.txt, rss.xml and JSON-LD, plus a strategy report:
npx tsx src/cli.ts site clients/plerosis.json --content out/plerosis --out out/site
```

## Running it for many clients

```bash
# 1. New client: paste their website address
npx tsx src/cli.ts onboard https://client.com [--llm gemini] [--repo owner/site-repo]
# 2. Give the client's access as secrets (names are in clients/<id>.json), then test it:
npx tsx src/cli.ts check clients/client.json
# 3. Done. The scheduled run (.github/workflows/seo-run.yml) writes and delivers articles on each client's cadence.
```

**Connectors** (`src/connectors`) deliver articles: `git` (opens a pull request; merging is the approval), `wordpress` (REST API, Application Password; saves a draft in review mode), `webhook` (signed JSON for Zapier/Make/n8n, covers Webflow, Shopify, Wix, etc.), `folder`. Config files only hold the NAMES of environment variables, never secrets.

**Free hosted AI for scheduled runs:** `--llm gemini|groq|openrouter` (free tiers exist; limits change). Set `SEO_LLM` / `SEO_MODEL` as repository variables.

**Run memory:** `data/<client>/history.json` is committed by the scheduler so topics never repeat.

**Alerts:** set `NOTIFY_WEBHOOK_URL` (Slack/Discord) to be told when a run fails.

## Pipeline

```
client profile -> plan topics -> research (your notes + own site) -> draft -> quality check -> markdown + SEO files
```

Deterministic code everywhere except the plan and draft steps. Review-first by default (`publish.mode`).

## SEO coverage (honest)

| Area | Covered | How |
|---|---|---|
| Crawlability and indexing | Yes | robots.txt parsing (incl. full-site block detection), sitemap checks, noindex, canonicals, orphan pages, pages missing from sitemap |
| HTTP health | Yes | 4xx/5xx, broken internal links, redirect chains, links that redirect |
| On-page (existing site) | Yes | titles, descriptions, H1s, duplicates, thin content, alt text, viewport, lang, Open Graph, URL style |
| On-page (new articles) | Yes | keyword placement, density, headings, readability (Flesch), link text, image alt, internal and outbound links |
| Structured data | Yes | audit for presence; generates Article, FAQPage, Organization, BreadcrumbList, LocalBusiness JSON-LD |
| AI search readiness | Yes | AI crawler access, llms.txt (unproven convention), answer-first openings, FAQ blocks, freshness |
| Content strategy | Yes | keyword clustering, cannibalisation detection, internal link suggestions, stale-content detection |
| Search demand | Yes | Search Console CSV export: striking distance, low CTR, content gaps |
| Accuracy | Partly | figures must be backed by a source; number-bearing sentences checked against sources. A human still reviews |
| Site files | Yes | sitemap.xml, robots.txt, llms.txt, RSS |
| Speed / Core Web Vitals | Yes (untested live) | `speed <url>` uses Google PageSpeed Insights (free) |
| Backlinks / off-page | **No** | cannot be automated safely or for free, and link schemes risk penalties |
| Rank tracking | **Partly** | Search Console CSV or live API (`gsc-api`, untested live); not third-party rank checking |
| Local SEO | Partly | LocalBusiness schema; Google Business Profile management is not covered |

## Layout

- `src/seo/` crawler, robots, audit, report, on-page, schema, files, clustering, links, freshness, Search Console, PageSpeed, onboarding
- `src/pipeline/` plan, research, draft, quality, run
- `src/providers/` AI (Anthropic, Ollama, Gemini/Groq/OpenRouter, mock) and sources (your files, own site, mock)
- `src/connectors/` git, wordpress, webhook, folder
- `src/publish/` markdown front matter, llms.txt, full site build
- `clients/` one JSON profile per client; put notes in `clients/<id>/sources/`

## Rules the engine enforces

- Figures and statistics must trace to a source; otherwise the draft is blocked.
- Banned phrases per client (for example "guaranteed").
- No H1 in article bodies, no images without alt text, FAQ required, internal links required.
- Drafts are written with `reviewed: false` and wait for a human unless the client is set to `auto`.

## Not yet built

- Dashboard and review queue, multi-client accounts, billing.
- Live AI-citation checks (asking assistants your customers' questions).
- Image generation (alt text is enforced, but images are not created).
- The crawler, connectors, PageSpeed and Search Console API were tested offline against fakes. None has been run against a live site or service yet.
