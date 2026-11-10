import { createHmac } from 'node:crypto';
import type { Connector, Env, Fetch, PublishContext, PublishItem, PublishResult } from './types.js';

export interface WebhookConfig {
  type: 'webhook';
  url: string;
  /** NAME of an environment variable holding a shared secret used to sign each request (optional). */
  secretEnv?: string;
}

/**
 * The catch-all plug for any platform (Webflow, Shopify, Wix, a custom CMS...). The engine POSTs the article as JSON;
 * whatever sits at the other end (Zapier, Make, n8n or the client's own code) files it where it belongs.
 * Signed with HMAC-SHA256 in the x-seo-engine-signature header so the receiver can trust it came from us.
 */
export class WebhookConnector implements Connector {
  readonly type = 'webhook';
  constructor(
    private cfg: WebhookConfig,
    private env: Env = process.env,
    private fetchFn: Fetch = fetch,
  ) {}

  async check(): Promise<string[]> {
    if (!/^https:\/\//.test(this.cfg.url)) return ['Webhook URL must start with https://'];
    if (this.cfg.secretEnv && !this.env[this.cfg.secretEnv]) return [`Set ${this.cfg.secretEnv} (the signing secret).`];
    return [];
  }

  async publish(items: PublishItem[], ctx: PublishContext): Promise<PublishResult[]> {
    const out: PublishResult[] = [];
    for (const i of items) {
      const body = JSON.stringify({
        client: ctx.clientId,
        status: ctx.mode === 'auto' ? 'publish' : 'draft',
        article: { slug: i.slug, title: i.title, description: i.description, tags: i.tags, markdown: i.body },
      });
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const secret = this.cfg.secretEnv ? this.env[this.cfg.secretEnv] : undefined;
      if (secret) headers['x-seo-engine-signature'] = createHmac('sha256', secret).update(body).digest('hex');
      const res = await this.fetchFn(this.cfg.url, { method: 'POST', headers, body });
      out.push({ slug: i.slug, ok: res.ok, note: res.ok ? 'Delivered.' : `Receiver returned ${res.status}.` });
    }
    return out;
  }
}
