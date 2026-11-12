import { appCreated, config, contextFor, disconnect, finish, githubCallback, pending, prepareApp, startGithub } from './connect';
import { GithubError } from './github';
import { siteCheck, signup } from './publicApi';
import { DbError } from './supabase';
import type { Deps, Env } from './types';

/**
 * The inbox site as a Cloudflare Worker: the built page is served as before, and a handful of /api/ addresses do the
 * server work for "Connect your website". Everything that is not /api/ goes straight to the page.
 */
export async function handle(req: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);

  const ctx = await contextFor(req, env, deps);
  if (ctx instanceof Response) return ctx;

  const route = `${req.method} ${url.pathname}`;
  try {
    switch (route) {
      // The two public front-page addresses. Anyone may call them; see publicApi.ts for how they stay safe.
      case 'POST /api/site-check':
        return await siteCheck(req, { db: ctx.db, f: ctx.f, now: ctx.now, origin: ctx.origin, secret: env.SUPABASE_SERVICE_KEY?.trim() ?? '' });
      case 'POST /api/signup':
        return await signup(req, { db: ctx.db, f: ctx.f, now: ctx.now, origin: ctx.origin, secret: env.SUPABASE_SERVICE_KEY?.trim() ?? '' });
      case 'GET /api/connect/config':
        return await config(req, ctx);
      case 'POST /api/connect/github/start':
        return await startGithub(req, ctx);
      case 'GET /api/connect/github/callback':
        return await githubCallback(req, ctx, url);
      case 'GET /api/connect/github/pending':
        return await pending(req, ctx, url);
      case 'POST /api/connect/github/finish':
        return await finish(req, ctx);
      case 'POST /api/connect/disconnect':
        return await disconnect(req, ctx);
      case 'POST /api/admin/github-app/prepare':
        return await prepareApp(req, ctx);
      case 'GET /api/admin/github-app/created':
        return await appCreated(req, ctx, url);
    }
  } catch (e) {
    // Messages from the database and GitHub helpers carry a status only, never a body or a key.
    console.error('connect request failed:', e instanceof Error ? e.message : 'unknown');
    // Only our own database and GitHub helpers add a hint (their messages are a step name and a status number, never a body or a key).
    // Anything else (a coding slip) shows its kind and a short message, with the service key blanked out if it ever appears.
    const raw = e instanceof DbError || e instanceof GithubError ? e.message : e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 160) : 'unknown error';
    const key = env.SUPABASE_SERVICE_KEY?.trim();
    const hint = ` (${key ? raw.split(key).join('[hidden]') : raw})`;
    return new Response(JSON.stringify({ error: `Something went wrong on our side. Please try again.${hint}`, code: 'server' }), { status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  const known = new Set(['/api/site-check', '/api/signup', '/api/connect/config', '/api/connect/github/start', '/api/connect/github/callback', '/api/connect/github/pending', '/api/connect/github/finish', '/api/connect/disconnect', '/api/admin/github-app/prepare', '/api/admin/github-app/created']);
  return new Response(JSON.stringify({ error: known.has(url.pathname) ? 'That address does not accept this kind of request.' : 'Not found.' }), {
    status: known.has(url.pathname) ? 405 : 404,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export default {
  fetch: (req: Request, env: Env) => handle(req, env),
};
