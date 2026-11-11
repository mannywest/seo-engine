import { z } from 'zod';
import { sha256 } from './hash.js';
import { AppTokenSource, appSettingsProblems, DEFAULT_APP_ID_ENV, DEFAULT_APP_KEY_ENV } from './githubApp.js';
import type { Connector, Env, Fetch, PublishContext, PublishItem, PublishResult, RevertContext, RevertResult } from './types.js';

const Handle = z.object({ prNumber: z.number(), branch: z.string(), path: z.string(), sha256: z.string() });
const refPath = (branch: string) => branch.split('/').map(encodeURIComponent).join('/');

export interface GitConfig {
  type: 'git';
  /** "owner/name" of the client's site repo. */
  repo: string;
  baseBranch: string;
  /** Folder inside the repo where articles live, e.g. src/content/blog */
  contentDir: string;
  /** NAME of the environment variable that holds a GitHub token (never the token itself). Ignored when installationId is set. */
  tokenEnv: string;
  /**
   * Set when the client connected through the engine's GitHub App (no token to paste). The engine then signs in as the app
   * and gets a one-hour key limited to this repo each time it publishes.
   */
  installationId?: number | undefined;
  /** NAMES of the environment variables holding the app id and private key. Default GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY. */
  appIdEnv?: string | undefined;
  privateKeyEnv?: string | undefined;
}

/**
 * For sites built from a GitHub repo (Astro, Next.js, Hugo, Jekyll, GitHub Pages...).
 * Opens a pull request containing the new articles. Merging the pull request is the approval step,
 * so in "review" mode a human taps Merge; in "auto" mode the engine merges it.
 */
export class GitConnector implements Connector {
  readonly type = 'git';
  private appTokens?: AppTokenSource;

  constructor(
    private cfg: GitConfig,
    private env: Env = process.env,
    private fetchFn: Fetch = fetch,
  ) {}

  private get usesApp(): boolean {
    return this.cfg.installationId !== undefined;
  }

  /** The key for this call: a one-hour app key when the client connected through the app, otherwise the token named in the config. */
  private async token(): Promise<string> {
    if (this.usesApp) {
      if (!this.appTokens) {
        const problems = appSettingsProblems(this.env, this.cfg.appIdEnv, this.cfg.privateKeyEnv);
        if (problems.length) throw new Error(problems.join(' '));
        this.appTokens = new AppTokenSource({
          appId: this.env[this.cfg.appIdEnv ?? DEFAULT_APP_ID_ENV]!,
          privateKey: this.env[this.cfg.privateKeyEnv ?? DEFAULT_APP_KEY_ENV]!,
          installationId: this.cfg.installationId!,
          repo: this.cfg.repo,
          fetchFn: this.fetchFn,
        });
      }
      return this.appTokens.token();
    }
    const token = this.env[this.cfg.tokenEnv];
    if (!token) throw new Error(`Environment variable ${this.cfg.tokenEnv} is not set.`);
    return token;
  }

  private async api(path: string, init: RequestInit = {}) {
    const token = await this.token();
    return this.fetchFn(`https://api.github.com/repos/${this.cfg.repo}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'seo-engine',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  }

  async check(): Promise<string[]> {
    if (this.usesApp) {
      const problems = appSettingsProblems(this.env, this.cfg.appIdEnv, this.cfg.privateKeyEnv);
      if (problems.length) return problems;
      try {
        await this.token();
      } catch (e) {
        return [e instanceof Error ? e.message : String(e)];
      }
    } else if (!this.env[this.cfg.tokenEnv]) return [`Set ${this.cfg.tokenEnv} to a GitHub token with write access to ${this.cfg.repo}.`];
    const res = await this.api('').catch((e: Error) => e);
    if (res instanceof Error) return [`Could not reach GitHub: ${res.message}`];
    if (res.status === 404) return [`Repo ${this.cfg.repo} not found, or the token cannot see it.`];
    if (res.status === 401) return ['The GitHub token was rejected (expired or wrong).'];
    if (!res.ok) return [`GitHub returned ${res.status}.`];
    const json = (await res.json()) as { permissions?: { push?: boolean } };
    if (json.permissions && !json.permissions.push) return ['The token can read the repo but not write to it.'];
    return [];
  }

  async publish(items: PublishItem[], ctx: PublishContext): Promise<PublishResult[]> {
    if (!items.length) return [];
    const base = this.cfg.baseBranch;
    const ref = await this.api(`/git/ref/heads/${encodeURIComponent(base)}`);
    if (!ref.ok) throw new Error(`Could not read branch ${base} (${ref.status}).`);
    const sha = ((await ref.json()) as { object: { sha: string } }).object.sha;

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    const branch = `seo-engine/${stamp}-${items[0]!.slug}`.slice(0, 120);
    const mk = await this.api('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }) });
    if (!mk.ok) throw new Error(`Could not create branch (${mk.status}): ${await mk.text()}`);

    const results: PublishResult[] = [];
    const added: PublishItem[] = [];
    const pushed = new Map<string, { path: string; sha256: string }>();
    for (const item of items) {
      const path = `${this.cfg.contentDir.replace(/\/$/, '')}/${item.slug}.md`;
      const exists = await this.api(`/contents/${path}?ref=${encodeURIComponent(base)}`);
      if (exists.ok) {
        results.push({ slug: item.slug, ok: false, note: `${path} already exists on ${base}; skipped.` });
        continue;
      }
      // Merging the PR is the approval, so the file is marked published.
      const markdown = item.markdown.replace(/^status: draft$/m, 'status: published');
      const put = await this.api(`/contents/${path}`, {
        method: 'PUT',
        body: JSON.stringify({
          message: `Add article: ${item.title}`,
          content: Buffer.from(markdown, 'utf8').toString('base64'),
          branch,
        }),
      });
      if (!put.ok) results.push({ slug: item.slug, ok: false, note: `Could not add file (${put.status}).` });
      else {
        added.push(item);
        pushed.set(item.slug, { path, sha256: sha256(markdown) });
      }
    }
    if (!added.length) return results;

    const pr = await this.api('/pulls', {
      method: 'POST',
      body: JSON.stringify({
        title: `SEO articles for ${ctx.clientName}: ${added.map((a) => a.title).join('; ')}`.slice(0, 240),
        head: branch,
        base,
        body: [
          `Articles written by seo-engine for ${ctx.clientName}.`,
          '',
          ...added.map((a) => `- **${a.title}** (\`${a.slug}\`)`),
          '',
          ctx.mode === 'review' ? 'Review the text, then merge to publish.' : 'Auto mode: this will be merged automatically.',
        ].join('\n'),
      }),
    });
    if (!pr.ok) throw new Error(`Could not open pull request (${pr.status}): ${await pr.text()}`);
    const prJson = (await pr.json()) as { html_url: string; number: number };

    let note = ctx.mode === 'review' ? 'Waiting for your approval (merge the PR).' : undefined;
    if (ctx.mode === 'auto') {
      const merge = await this.api(`/pulls/${prJson.number}/merge`, { method: 'PUT', body: JSON.stringify({ merge_method: 'squash' }) });
      note = merge.ok ? 'Merged automatically.' : `Auto-merge failed (${merge.status}); merge it by hand.`;
    }
    for (const a of added) {
      const file = pushed.get(a.slug);
      results.push({
        slug: a.slug,
        ok: true,
        url: prJson.html_url,
        note,
        ...(file ? { handle: { prNumber: prJson.number, branch, path: file.path, sha256: file.sha256 } satisfies z.infer<typeof Handle> } : {}),
      });
    }
    return results;
  }

  /**
   * Takes an article back out. If its pull request was never merged, the pull request is closed and its branch removed.
   * If it was merged, a new pull request that removes the file is opened (and merged straight away only in auto mode).
   * Refuses if the file on the main branch has been changed since we delivered it.
   * Note: closing a pull request closes everything in it. The engine delivers one article per pull request.
   */
  async revert(handle: Record<string, unknown>, ctx: RevertContext): Promise<RevertResult> {
    const h = Handle.parse(handle);
    const base = this.cfg.baseBranch;
    const prRes = await this.api(`/pulls/${h.prNumber}`);
    if (!prRes.ok) throw new Error(`Could not read pull request #${h.prNumber} (${prRes.status}).`);
    const pr = (await prRes.json()) as { state?: string; merged?: boolean; merged_at?: string | null };

    if (!pr.merged && !pr.merged_at) {
      if (pr.state === 'open') {
        const close = await this.api(`/pulls/${h.prNumber}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
        if (!close.ok) throw new Error(`Could not close pull request #${h.prNumber} (${close.status}).`);
      }
      await this.api(`/git/refs/heads/${refPath(h.branch)}`, { method: 'DELETE' }).catch(() => undefined); // already gone is fine
      return { ok: true, note: pr.state === 'open' ? `Closed pull request #${h.prNumber} without publishing it.` : `Pull request #${h.prNumber} was never merged, so nothing was live.` };
    }

    const file = await this.api(`/contents/${h.path}?ref=${encodeURIComponent(base)}`);
    if (file.status === 404) return { ok: true, note: `The article is already gone from ${base}, so there was nothing to undo.` };
    if (!file.ok) throw new Error(`Could not read ${h.path} on ${base} (${file.status}).`);
    const current = (await file.json()) as { sha: string; content?: string };
    const text = Buffer.from(current.content ?? '', 'base64').toString('utf8');
    if (sha256(text) !== h.sha256 && !ctx.force) {
      return { ok: false, refused: true, note: `${h.path} has been changed on ${base} since it was delivered, so it was left alone. Undo it with force if you are sure.` };
    }

    // An undo for this article may already be open (asking twice must not open a second one).
    const openPrs = await this.api('/pulls?state=open&per_page=100');
    if (openPrs.ok) {
      const existing = ((await openPrs.json()) as { title?: string; html_url: string }[]).find((p) => p.title?.startsWith('Undo: ') && p.title.includes(`(from #${h.prNumber})`));
      if (existing) return { ok: true, pending: true, url: existing.html_url, note: 'The undo pull request is already open. Merge it to take the article off the site.' };
    }

    const ref = await this.api(`/git/ref/heads/${encodeURIComponent(base)}`);
    if (!ref.ok) throw new Error(`Could not read branch ${base} (${ref.status}).`);
    const baseSha = ((await ref.json()) as { object: { sha: string } }).object.sha;
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    const branch = `seo-engine/revert-${stamp}-${h.path.split('/').pop()!.replace(/\.md$/, '')}`.slice(0, 120);
    const mk = await this.api('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }) });
    if (!mk.ok) throw new Error(`Could not create branch (${mk.status}): ${await mk.text()}`);
    const del = await this.api(`/contents/${h.path}`, {
      method: 'DELETE',
      body: JSON.stringify({ message: `Remove article (undo of #${h.prNumber})`, sha: current.sha, branch }),
    });
    if (!del.ok) throw new Error(`Could not remove ${h.path} (${del.status}).`);
    const open = await this.api('/pulls', {
      method: 'POST',
      body: JSON.stringify({
        title: `Undo: remove ${h.path.split('/').pop()} (from #${h.prNumber})`.slice(0, 240),
        head: branch,
        base,
        body: `Takes back the article delivered for ${ctx.clientName} in #${h.prNumber}.\n\n${ctx.mode === 'review' ? 'Merge to take it off the site.' : 'Auto mode: this will be merged automatically.'}`,
      }),
    });
    if (!open.ok) throw new Error(`Could not open the undo pull request (${open.status}): ${await open.text()}`);
    const opened = (await open.json()) as { html_url: string; number: number };
    if (ctx.mode === 'auto') {
      const merge = await this.api(`/pulls/${opened.number}/merge`, { method: 'PUT', body: JSON.stringify({ merge_method: 'squash' }) });
      if (merge.ok) return { ok: true, url: opened.html_url, note: 'The article has been taken off the site (undo merged automatically).' };
      return { ok: true, pending: true, url: opened.html_url, note: `Opened the undo pull request, but merging it failed (${merge.status}); merge it by hand.` };
    }
    return { ok: true, pending: true, url: opened.html_url, note: 'Opened a pull request that removes the article. Merge it to take the article off the site.' };
  }
}
