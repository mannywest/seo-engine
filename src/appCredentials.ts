import { DEFAULT_APP_ID_ENV, DEFAULT_APP_KEY_ENV } from './connectors/githubApp.js';
import type { Env, Fetch } from './connectors/types.js';
import { hostedSettings, supabaseHeaders } from './stateStore.js';

/**
 * Where the engine finds the GitHub App's id and private key.
 *
 * When the "Connect your website" set-up creates the app, GitHub hands the key straight to the server piece, which
 * stores it in the Supabase Vault. Nobody ever sees or copies it. On each run the engine asks the database for it
 * (using the service key it already has) and puts it in the run's environment, where the GitHub connector looks.
 * A key that is already in the environment (a GitHub secret, SECRETS_JSON) wins, so a hand-made app still works.
 */

/** Something to tell the person running the engine in plain English. */
export class AppCredentialsError extends Error {}

export interface AppCredentialsOptions {
  /** The environment to read and fill. Defaults to the real one. */
  env?: Env;
  fetch?: Fetch;
  /** Names of the variables to fill, when a connector uses others than GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY. */
  appIdEnv?: string | undefined;
  privateKeyEnv?: string | undefined;
}

const present = (v: string | undefined) => !!v && v.trim() !== '';

async function readSecret(url: string, key: string, name: string, fetchFn: Fetch): Promise<string | undefined> {
  let res: Response;
  try {
    res = await fetchFn(`${url.replace(/\/+$/, '')}/rest/v1/rpc/lodestar_get_secret`, {
      method: 'POST',
      headers: supabaseHeaders(key),
      body: JSON.stringify({ p_name: name }),
    });
  } catch (e) {
    throw new AppCredentialsError(`Could not reach the database to read the GitHub App key: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    // Never echo the response body: it could contain the secret's name or context we do not want in logs.
    throw new AppCredentialsError(`Could not read the GitHub App key from the database (status ${res.status}). Has the latest supabase/schema.sql been run?`);
  }
  const text = await res.text();
  if (!text) return undefined;
  const value: unknown = JSON.parse(text);
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Fills the app id and private key from the Vault for any that the environment does not already have.
 * Does nothing (and makes no request) when both are present, or when the engine is not using the hosted database.
 * Leaves a variable unset when the Vault has no value, so the connector's own "set GITHUB_APP_ID" message still appears.
 */
export async function ensureAppCredentials(o: AppCredentialsOptions = {}): Promise<void> {
  const env = o.env ?? process.env;
  const idName = o.appIdEnv ?? DEFAULT_APP_ID_ENV;
  const keyName = o.privateKeyEnv ?? DEFAULT_APP_KEY_ENV;
  const needId = !present(env[idName]);
  const needKey = !present(env[keyName]);
  if (!needId && !needKey) return;
  const hosted = hostedSettings(env);
  if (!hosted) return;
  const fetchFn = o.fetch ?? fetch;
  if (needId) {
    const id = await readSecret(hosted.url, hosted.key, 'github_app_id', fetchFn);
    if (id) env[idName] = id;
  }
  if (needKey) {
    const pem = await readSecret(hosted.url, hosted.key, 'github_app_private_key', fetchFn);
    if (pem) env[keyName] = pem;
  }
}
