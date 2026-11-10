# First live run: a plain-English checklist

Goal: find out what really works. So far the engine has only been tested against fakes. This checklist runs it for real, one small step at a time, on your own computer. **Nothing here publishes anything to a live website.**

After each step, note: **worked** or **failed**, and if it failed, copy the exact error text. That is all we need.

## Safety rules

- Never paste a key or password into a chat. Type it into the command yourself, as shown below.
- Only use public information from the site. Free AI services may use what you send them to improve their products.
- Stop at any step that asks to publish, send or pay. None of these should.

## Before you start (once)

You need two things installed: **Node** (version 22 or newer) and **Git**.

1. Open a terminal (Terminal on Mac, PowerShell on Windows).
2. Type `node -v` and press Enter. You should see a number starting with `v22` or higher. If not, install Node from nodejs.org.
3. Download the project and move into it:
   `git clone https://github.com/mannywest/seo-engine.git`
   `cd seo-engine`
4. Install what it needs: `npm install` (takes a minute or two).
5. Run its self-test: `npm run verify`. You should see **54 tests passed**. If not, copy the last 20 lines and send them over.

## Step 1: Audit a real website (free, no login)

This crawls a site and writes a report on its technical health.

`npx tsx src/cli.ts audit https://plerosis.com --out out/audit.md`

- **Worked:** a file appears at `out/audit.md` listing issues (titles, links, indexing and so on).
- **Failed:** an error, a timeout, or an empty file.
- **Send back:** the file, or the error text.

## Step 2: Speed check (free)

This uses Google's free PageSpeed service.

`npx tsx src/cli.ts speed https://plerosis.com`

- **Worked:** it prints speed scores and advice.
- **Failed:** an error, often "rate limit". If so, wait a few minutes and try once more.
- **Send back:** what it printed, or the error.

## Step 3: Make practice articles (free, placeholder text)

This tests the whole pipeline without any AI.

`npx tsx src/cli.ts run clients/plerosis.json --mock`

- **Worked:** it reports it wrote articles, and files appear in the output folder it names.
- **Failed:** an error.
- **Send back:** one of the files, or the error.

## Step 4: Make one real article with a free AI model

Get a free key from Google AI Studio (search "Google AI Studio API key"). Then run this, putting your key where it says `YOUR_KEY` (type it yourself):

`GEMINI_API_KEY=YOUR_KEY npx tsx src/cli.ts run clients/plerosis.json --live --llm gemini --crawl`

On Windows PowerShell, set the key first with `$env:GEMINI_API_KEY="YOUR_KEY"` and then run the command without the key part at the front.

- **Worked:** a real article file, marked `reviewed: false`. Read it. Is it accurate and in the right voice?
- **Blocked:** the engine may refuse a draft and say why, for example a number with no source. That is the safety check working. Send the reason.
- **Failed:** an error, often a limit on the free plan.
- **Send back:** the article, plus your honest opinion of its quality.

## Step 5 (only when 1 to 4 are done): test a delivery connection

Do not do this yet if you are unsure. It needs secrets set up first, and the safest option is the one that only creates a pull request on GitHub or saves a draft, never a live post.

`npx tsx src/cli.ts check clients/plerosis.json`

- **Worked:** it reports each connection as OK.
- **Failed:** it names the missing secret or the error.

## What to send back

For each step: the step number, worked or failed, and the file or error text. Photos of the screen are fine.

## What this will and will not prove

- It will show whether the crawler, PageSpeed link and article pipeline work on a real site, and how good a free-model article is.
- It will not test Search Console, Google Business Profile, sign-up, billing or the client assistant. Those are not built or not connected yet.
