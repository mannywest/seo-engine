import { z } from 'zod';
import { FolderConnector } from './folder.js';
import { GitConnector } from './git.js';
import type { Connector, Env, Fetch } from './types.js';
import { WebhookConnector } from './webhook.js';
import { WordPressConnector } from './wordpress.js';

/**
 * .strict() means a stray field such as "token" or "password" is rejected on purpose:
 * config files only ever name an environment variable, so secrets cannot be committed by accident.
 */
export const ConnectorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('folder'), dir: z.string() }).strict(),
  z
    .object({
      type: z.literal('git'),
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'use owner/name'),
      baseBranch: z.string().default('main'),
      contentDir: z.string().default('src/content/blog'),
      tokenEnv: z.string().default('GITHUB_TOKEN'),
      /** Set by the "Connect your website" flow. When present the engine signs in as the GitHub App instead of using a token. */
      installationId: z.number().int().positive().optional(),
      appIdEnv: z.string().optional(),
      privateKeyEnv: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('wordpress'),
      siteUrl: z.string().url(),
      userEnv: z.string(),
      passwordEnv: z.string(),
    })
    .strict(),
  z.object({ type: z.literal('webhook'), url: z.string().url(), secretEnv: z.string().optional() }).strict(),
]);
export type ConnectorConfig = z.infer<typeof ConnectorSchema>;

export function createConnector(raw: unknown, env: Env = process.env, fetchFn: Fetch = fetch): Connector {
  const cfg = ConnectorSchema.parse(raw);
  switch (cfg.type) {
    case 'folder':
      return new FolderConnector(cfg.dir);
    case 'git':
      return new GitConnector(cfg, env, fetchFn);
    case 'wordpress':
      return new WordPressConnector(cfg, env, fetchFn);
    case 'webhook':
      return new WebhookConnector(cfg, env, fetchFn);
  }
}

export type { Connector, PublishContext, PublishItem, PublishResult } from './types.js';
