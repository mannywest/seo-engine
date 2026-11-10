import { marked } from 'marked';
import { z } from 'zod';
import type { Connector, Env, Fetch, PublishContext, PublishItem, PublishResult, RevertContext, RevertResult } from './types.js';

const Handle = z.object({ postId: z.number(), modifiedGmt: z.string().optional() });

export interface WordPressConfig {
  type: 'wordpress';
  siteUrl: string;
  /** NAMES of environment variables (an Application Password, not the real login password). */
  userEnv: string;
  passwordEnv: string;
}

/**
 * WordPress sites, through WordPress's own REST API. The client creates an "Application Password"
 * (Users > Profile) and gives it to us; we never need their real password.
 * "review" mode saves a WordPress draft; "auto" mode publishes.
 */
export class WordPressConnector implements Connector {
  readonly type = 'wordpress';
  constructor(
    private cfg: WordPressConfig,
    private env: Env = process.env,
    private fetchFn: Fetch = fetch,
  ) {}

  private headers() {
    const u = this.env[this.cfg.userEnv];
    const p = this.env[this.cfg.passwordEnv];
    if (!u || !p) throw new Error(`Set ${this.cfg.userEnv} and ${this.cfg.passwordEnv}.`);
    return {
      authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`,
      'content-type': 'application/json',
    };
  }
  private url(path: string) {
    return `${this.cfg.siteUrl.replace(/\/$/, '')}/wp-json/wp/v2${path}`;
  }

  async check(): Promise<string[]> {
    if (!this.env[this.cfg.userEnv] || !this.env[this.cfg.passwordEnv]) {
      return [`Set ${this.cfg.userEnv} and ${this.cfg.passwordEnv} (a WordPress Application Password).`];
    }
    const res = await this.fetchFn(this.url('/users/me'), { headers: this.headers() }).catch((e: Error) => e);
    if (res instanceof Error) return [`Could not reach the site: ${res.message}`];
    if (res.status === 401 || res.status === 403) return ['WordPress rejected the username or Application Password.'];
    if (res.status === 404) return ['The WordPress REST API was not found. A security plugin may be blocking /wp-json/.'];
    return res.ok ? [] : [`WordPress returned ${res.status}.`];
  }

  async publish(items: PublishItem[], ctx: PublishContext): Promise<PublishResult[]> {
    const out: PublishResult[] = [];
    for (const i of items) {
      const res = await this.fetchFn(this.url('/posts'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          title: i.title,
          slug: i.slug,
          excerpt: i.description,
          content: await marked.parse(i.body),
          status: ctx.mode === 'auto' ? 'publish' : 'draft',
        }),
      });
      if (!res.ok) {
        out.push({ slug: i.slug, ok: false, note: `WordPress returned ${res.status}.` });
        continue;
      }
      const json = (await res.json()) as { link?: string; id?: number; modified_gmt?: string };
      out.push({
        slug: i.slug,
        ok: true,
        url: json.link,
        note: ctx.mode === 'auto' ? 'Published.' : 'Saved as a WordPress draft; open it and press Publish.',
        ...(typeof json.id === 'number' ? { handle: { postId: json.id, ...(json.modified_gmt ? { modifiedGmt: json.modified_gmt } : {}) } } : {}),
      });
    }
    return out;
  }

  /** Moves the post to the WordPress trash, where it can be restored. Refuses if someone edited it after we delivered it. */
  async revert(handle: Record<string, unknown>, ctx: RevertContext): Promise<RevertResult> {
    const h = Handle.parse(handle);
    const got = await this.fetchFn(this.url(`/posts/${h.postId}?context=edit`), { headers: this.headers() });
    if (got.status === 404) return { ok: true, note: 'The post was already gone, so there was nothing to undo.' };
    if (!got.ok) throw new Error(`WordPress returned ${got.status} when looking up post ${h.postId}.`);
    const now = (await got.json()) as { status?: string; modified_gmt?: string };
    if (now.status === 'trash') return { ok: true, note: 'The post was already in the WordPress trash.' };
    if (h.modifiedGmt && now.modified_gmt !== h.modifiedGmt && !ctx.force) {
      return { ok: false, refused: true, note: 'The post has been edited in WordPress since it was delivered, so it was left alone. Undo it with force if you are sure.' };
    }
    // No "force" parameter on the DELETE: WordPress moves the post to the trash instead of erasing it.
    const del = await this.fetchFn(this.url(`/posts/${h.postId}`), { method: 'DELETE', headers: this.headers() });
    if (!del.ok) throw new Error(`WordPress returned ${del.status} when moving post ${h.postId} to the trash.`);
    const checked = h.modifiedGmt ? '' : ' (WordPress did not say when it was last edited, so later edits could not be checked)';
    return { ok: true, note: `Moved the post to the WordPress trash, where it can be restored${checked}.` };
  }
}
