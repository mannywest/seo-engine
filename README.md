# seo-engine

An automated content engine for SEO and AI search. For each client it plans topics, researches them, drafts articles, runs automatic quality checks, and outputs markdown files ready to publish to the client's site. Plerosis is the first client.

## How it works

```
client profile -> plan topics -> research sources -> draft -> quality check -> markdown file
```

- **Deterministic pipeline, AI only at the plan and draft steps.** Everything else is plain code.
- **Review-first by default.** A client's `publish.mode` is `review` (drafts wait for approval) or `auto` (publish when checks pass).
- **No invented facts.** The quality check flags any statistic or money figure that no source supports, plus banned phrases, missing FAQ, too few internal links, bad title/description length, and duplicate slugs.

## Use

```bash
npm install
npm run verify      # typecheck and tests
npm run run:mock    # full pipeline, no AI calls, no cost, placeholder output
```

`--live` mode (real AI drafting) is deliberately not finished: it needs an `ANTHROPIC_API_KEY`, a chosen search API, and approval of the spend.

## Layout

- `src/pipeline/` plan, research, draft, quality, run
- `src/providers/` LLM and search providers (real and mock)
- `src/publish/` markdown/front matter and `llms.txt`
- `clients/` one JSON profile per client

## Next

1. Choose and add a live search provider.
2. Run live on Plerosis with a spending cap; review the drafts by hand.
3. Git publisher that opens a pull request on the client's site repo.
4. Dashboard and review queue, then multi-client support and billing.
