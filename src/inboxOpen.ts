import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileInboxStore, type InboxStore } from './inbox.js';
import { SupabaseInboxStore } from './inboxSupabase.js';

export class InboxConfigError extends Error {}

type Env = Record<string, string | undefined>;

/**
 * Opens a client's approval inbox: the hosted one (Supabase) when both SUPABASE_URL and SUPABASE_SERVICE_KEY
 * are set, otherwise the local file. Blank values count as not set, because an unset GitHub secret arrives as "".
 *
 * Only one of the two being set is an error, never a quiet fallback: on GitHub Actions a local file disappears
 * when the run ends, so a half-configured run would lose articles without anyone noticing.
 */
export async function openInbox(
  clientId: string,
  o: { dataDir?: string; env?: Env; fetch?: typeof fetch } = {},
): Promise<InboxStore> {
  const env = o.env ?? process.env;
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_KEY?.trim();
  if (url && key) return new SupabaseInboxStore({ url, key, clientId, ...(o.fetch ? { fetch: o.fetch } : {}) });
  if (url || key) {
    throw new InboxConfigError(
      `The hosted inbox is half set up: ${url ? 'SUPABASE_SERVICE_KEY' : 'SUPABASE_URL'} is missing. Set both, or neither to use the local file.`,
    );
  }
  return FileInboxStore.load(clientId, o.dataDir);
}

/** A client id may only be letters, digits and hyphens, so it can never be used to reach another folder or run a command. */
export const SAFE_CLIENT_ID = /^[a-z0-9][a-z0-9-]*$/i;

/**
 * The client files whose approved articles should be published: every client with the inbox switched on,
 * or just the one named. Returns file paths like clients/acme.json, in a stable order.
 */
export async function inboxClientFiles(dir = 'clients', only?: string): Promise<string[]> {
  if (only !== undefined) {
    if (!SAFE_CLIENT_ID.test(only)) throw new InboxConfigError(`"${only}" is not a valid client id (letters, digits and hyphens only).`);
    const path = join(dir, `${only}.json`);
    try {
      await readFile(path, 'utf8');
    } catch {
      throw new InboxConfigError(`There is no client file at ${path}.`);
    }
    return [path];
  }
  const out: string[] = [];
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()) {
    const path = join(dir, f);
    try {
      const j = JSON.parse(await readFile(path, 'utf8')) as { publish?: { inbox?: unknown } };
      if (j.publish?.inbox === true) out.push(path);
    } catch {
      /* a client file that is not valid JSON is reported when it is loaded; it is not an inbox client here */
    }
  }
  return out;
}
