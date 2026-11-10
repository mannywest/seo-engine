import type { Connector, Env, Fetch, PublishContext, PublishItem, PublishResult } from './types.js';

export interface GitConfig {
  type: 'git';
  /** "owner/name" of the client's site repo. */
  repo: string;
  baseBranch: string;
  /** Folder inside the repo where articles live, e.g. src/content/blog */
  contentDir: string;
  /** NAME of the environment variable that holds a GitHub token (never the token itself). */
  tokenEnv: string;
}

/**
 * For sites built from a GitHub repo (Astro, Next.js, Hugo, Jekyll, GitHub Pages...).
 * Opens a pull request containing the new articles. Merging the pull request is the approval step,
 * so in "review" mode a human taps Merge; in "auto" mode the engine merges it.
 */
export class GitConnector implements Connector {
  readonly type = 'git';
  constructor(
    private cfg: GitConfig,
    private env: Env = process.env,
    private fetchFn: Fetch = fetch,
  ) {}

  private async api(path: string, init: RequestInit = {}) {
    const token = this.env[this.cfg.tokenEnv];
    if (!token) throw new Error(`Environment variable ${this.cfg.tokenEnv} is not set.`);
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
    if (!this.env[this.cfg.tokenEnv]) return [`Set ${this.cfg.tokenEnv} to a GitHub token with write access to ${this.cfg.repo}.`];
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
      else added.push(item);
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
    for (const a of added) results.push({ slug: a.slug, ok: true, url: prJson.html_url, note });
    return results;
  }
}
