import { z } from 'zod';
import { ConnectorSchema, type ConnectorConfig } from './connectors/index.js';
import type { Env } from './connectors/types.js';
import { hostedSettings, StateError, supabaseHeaders } from './stateStore.js';
import type { ClientProfile } from './types.js';

/**
 * Site connections: which kind of website a client has and how the engine reaches it.
 * Rows are written by the "Connect your website" screen's server piece and read here, so adding a client needs no code
 * change and no client file. Rows hold NO secrets (see supabase/schema.sql); keys and passwords are looked up by name.
 */

export const PLATFORMS = ['github', 'wordpress', 'wix', 'shopify', 'webhook', 'folder'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const ConnectionRowSchema = z.object({
  client_id: z.string(),
  platform: z.enum(PLATFORMS),
  status: z.enum(['connected', 'needs_attention', 'disconnected']),
  label: z.string(),
  settings: z.record(z.unknown()),
  last_problem: z.string().nullish(),
});
export type ConnectionRow = z.infer<typeof ConnectionRowSchema>;

/** Something a person can fix (reconnect the site, finish a platform's set-up). Worded for a client, not a developer. */
export class ConnectionError extends Error {}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Turns a stored connection into the connector settings the engine already understands. */
export function connectorFromConnection(row: ConnectionRow): ConnectorConfig {
  const s = row.settings;
  let raw: unknown;
  switch (row.platform) {
    case 'github':
      raw = {
        type: 'git',
        repo: s.repo,
        baseBranch: text(s.baseBranch) ?? 'main',
        contentDir: text(s.contentDir) ?? 'src/content/blog',
        installationId: s.installationId,
        ...(text(s.appIdEnv) ? { appIdEnv: text(s.appIdEnv) } : {}),
        ...(text(s.privateKeyEnv) ? { privateKeyEnv: text(s.privateKeyEnv) } : {}),
      };
      if (typeof s.installationId !== 'number') throw new ConnectionError(`${row.label}: the GitHub connection is incomplete (no installation). Ask the client to connect again.`);
      break;
    case 'wordpress':
      raw = { type: 'wordpress', siteUrl: s.siteUrl, userEnv: s.userEnv, passwordEnv: s.passwordEnv };
      break;
    case 'webhook':
      raw = { type: 'webhook', url: s.url, ...(text(s.secretEnv) ? { secretEnv: text(s.secretEnv) } : {}) };
      break;
    case 'folder':
      raw = { type: 'folder', dir: s.dir };
      break;
    case 'wix':
    case 'shopify':
      throw new ConnectionError(`${row.label}: connecting ${row.platform === 'wix' ? 'Wix' : 'Shopify'} sites is not available yet.`);
  }
  const parsed = ConnectorSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConnectionError(`${row.label}: the saved ${row.platform} connection is incomplete (${parsed.error.issues.map((i) => i.path.join('.') || i.message).join(', ')}). Ask the client to connect again.`);
  }
  return parsed.data;
}

export interface ConnectionOptions {
  env?: Env;
  fetch?: typeof fetch;
}

/**
 * Reads one client's connection from Supabase. Returns undefined when the engine is not using the hosted notebook
 * (local files only) or the client has no row. A failed read STOPS the run rather than quietly falling back to a file:
 * delivering to the wrong place is worse than not delivering.
 */
export async function fetchConnection(clientId: string, o: ConnectionOptions = {}): Promise<ConnectionRow | undefined> {
  const hosted = hostedSettings(o.env ?? process.env);
  if (!hosted) return undefined;
  const url = `${hosted.url.replace(/\/+$/, '')}/rest/v1/site_connections?select=client_id,platform,status,label,settings,last_problem&client_id=eq.${encodeURIComponent(clientId)}&limit=1`;
  const res = await (o.fetch ?? fetch)(url, { headers: supabaseHeaders(hosted.key) });
  const body = await res.text();
  if (!res.ok) throw new StateError(`Supabase GET on site_connections failed (${res.status}): ${body.slice(0, 300) || res.statusText}`);
  const rows: unknown = body ? JSON.parse(body) : [];
  if (!Array.isArray(rows)) throw new StateError('The database did not return a list of rows from the site_connections table.');
  if (!rows.length) return undefined;
  const parsed = ConnectionRowSchema.safeParse(rows[0]);
  if (!parsed.success) throw new StateError(`The saved connection for "${clientId}" could not be read: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  return parsed.data;
}

export interface WithConnectionOptions extends ConnectionOptions {
  /**
   * true (default): a connection that needs attention throws, because the caller is about to deliver something.
   * false: the connector is left out and the run carries on, so drafts still reach the approval inbox.
   */
  strict?: boolean;
}

/**
 * The profile as it should be used right now. A client's saved connection beats the "connector" in its file;
 * with no saved connection the file's connector is kept. The profile passed in is never changed.
 */
export async function withConnection(profile: ClientProfile, o: WithConnectionOptions = {}): Promise<ClientProfile> {
  const row = await fetchConnection(profile.id, o);
  if (!row) return profile;
  if (row.status !== 'connected') {
    const why = row.status === 'disconnected' ? 'the client has disconnected their website' : (row.last_problem ?? 'the connection needs attention');
    if (o.strict ?? true) throw new ConnectionError(`${row.label}: ${why}. Ask the client to connect again.`);
    console.warn(`${profile.id}: ${row.label}: ${why}. Drafts will wait in the approval inbox.`);
    const { connector: _left, ...rest } = profile;
    return rest as ClientProfile;
  }
  return { ...profile, connector: connectorFromConnection(row) };
}
