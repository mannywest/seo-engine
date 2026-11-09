# seo-engine

An automated content and SEO engine. For each client it audits the site, plans topics, researches from the client's own material, drafts articles, checks them, and produces everything a site needs to be found by Google and by AI assistants. Plerosis is the first client.

Everything runs free **except** the AI that writes the article text, and even that has a free option (a local model through Ollama).

## Commands

```bash
npm install
npm run verify                                   # typecheck + 31 tests

# Write articles (placeholder text, no cost):
npx tsx src/cli.ts run clients/plerosis.json --mock

# Write real articles from YOUR notes (free with a local model):
npx tsx src/cli.ts run clients/plerosis.json --live --llm ollama --sources clients/plerosis/sources
npx tsx src/cli.ts run clients/plerosis.json --live --llm ollama --crawl   # also use the client's own site as a source

# Paid API instead of a local model (spends money):
ANTHROPIC_API_KEY=... npx tsx src/cli.ts run clients/plerosis.json --live --llm anthropic

# Audit any site (technical, on-page, structured data, AI search):
npx tsx src/cli.ts audit https://plerosis.com --out out/audit.md

# Find opportunities in a Google Search Console export (Queries.csv):
npx tsx src/cli.ts gsc ~/Downloads/Queries.csv

# Build sitemap.xml, robots.txt, llms.txt, rss.xml and JSON-LD, plus a strategy report:
npx tsx src/cli.ts site clients/plerosis.json --content out/plerosis --out out/site
```

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
| Speed / Core Web Vitals | **No** | not measured here. Use Lighthouse or PageSpeed Insights (both free) |
| Backlinks / off-page | **No** | cannot be automated safely or for free, and link schemes risk penalties |
| Rank tracking | **Partly** | via Search Console exports, not live rank checking |
| Local SEO | Partly | LocalBusiness schema; Google Business Profile management is not covered |

## Layout

- `src/seo/` crawler, robots, audit, report, on-page, schema, files, clustering, links, freshness, Search Console
- `src/pipeline/` plan, research, draft, quality, run
- `src/providers/` AI (Anthropic, Ollama, mock) and sources (your files, own site, mock)
- `src/publish/` markdown front matter, llms.txt, full site build
- `clients/` one JSON profile per client; put notes in `clients/<id>/sources/`

## Rules the engine enforces

- Figures and statistics must trace to a source; otherwise the draft is blocked.
- Banned phrases per client (for example "guaranteed").
- No H1 in article bodies, no images without alt text, FAQ required, internal links required.
- Drafts are written with `reviewed: false` and wait for a human unless the client is set to `auto`.

## Not yet built

- Git publisher that opens a pull request on the client's site repo.
- Dashboard and review queue, multi-client accounts, billing.
- Live AI-citation checks (asking assistants your customers' questions).
- The crawler and fetchers were tested offline against fake sites. They have not been run against a live site from this environment.
