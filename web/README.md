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

## The connect piece (Worker)
`worker/` is a small Cloudflare Worker that serves this page and answers `/api/*` (the "Connect your website" screen).
It holds the one thing the page must never hold: the Supabase **service key**.

| Where | Name | Value |
| --- | --- | --- |
| `wrangler.jsonc` (public) | `SUPABASE_URL` | the project URL |
| Cloudflare dashboard, Worker secret | `SUPABASE_SERVICE_KEY` | the service key. Type it into Cloudflare yourself; never into chat, code or git |

Run the updated `../supabase/schema.sql` once (it is safe to run again) and add yourself as an admin in `platform_admins`
(SQL editor), then use "Create the GitHub App" on the Connect screen. GitHub hands the app's key straight to the Worker,
which keeps it in the Supabase Vault; the engine reads it from there (`src/appCredentials.ts`). Nobody copies a key.
Links are signed, expire after 15 minutes and work once. Without `SUPABASE_SERVICE_KEY` the Worker answers `not_configured`.

## Commands
```
cd web
npm ci           # uses the committed package-lock.json (Cloudflare runs this too)
npm run dev      # local preview
npm run verify   # typecheck + tests + build
```
