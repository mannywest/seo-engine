# Lodestar inbox (web app)

The screen people tap to approve, edit or reject articles. React + Vite, built into one self-contained page.

## Try it now (no account needed)
Run it with no settings and it starts in **demo mode**: sample articles, a clear banner, nothing is saved or published.

## Real mode
Set these two values when building (Cloudflare Pages: Settings, Environment variables):

| Name | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | the project URL, e.g. `https://abcd1234.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | the **public (anon / publishable)** key only |

Never use the service key here. If one is found the app refuses to start.

People sign in with an emailed link. What each person can see and do is enforced by the database
(`../supabase/schema.sql`), not by this page. Approving marks the article approved; the engine publishes it on its next run.

## Commands
```
cd web
npm install      # (npm ci fails; do not commit package-lock.json)
npm run dev      # local preview
npm run verify   # typecheck + tests + build
```
