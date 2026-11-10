import { createSign } from 'node:crypto';
import type { GscRow } from './gsc.js';

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Builds the signed login ticket Google asks a "service account" to present. */
export function buildJwt(sa: ServiceAccount, now = Math.floor(Date.now() / 1000)): string {
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key);
  return `${head}.${claim}.${b64u(sig)}`;
}

/**
 * Live Search Console data, free. Onboarding for a client is one step: they add our service account's email
 * as a (read-only) user in their Search Console. No passwords, no OAuth screens.
 * siteUrl is exactly as Search Console lists it: "https://example.com/" or "sc-domain:example.com".
 */
export async function fetchGscQueries(
  siteUrl: string,
  opts: { days?: number; env?: Record<string, string | undefined>; fetchFn?: typeof fetch } = {},
): Promise<GscRow[]> {
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetchFn ?? fetch;
  const raw = env.GSC_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Set GSC_SERVICE_ACCOUNT_JSON to the service account key (the whole JSON).');
  const sa = JSON.parse(raw) as ServiceAccount;

  const tokenRes = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: buildJwt(sa) }),
  });
  if (!tokenRes.ok) throw new Error(`Google refused the service account (${tokenRes.status}).`);
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  // Search Console data lags by about two days.
  const end = new Date(Date.now() - 2 * 86_400_000);
  const start = new Date(end.getTime() - (opts.days ?? 28) * 86_400_000);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const res = await fetchFn(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ startDate: day(start), endDate: day(end), dimensions: ['query'], rowLimit: 1000 }),
  });
  if (res.status === 403) throw new Error('Search Console says this service account has no access to that site. Add its email as a user.');
  if (!res.ok) throw new Error(`Search Console returned ${res.status}.`);
  const json = (await res.json()) as { rows?: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[] };
  return (json.rows ?? []).map((r) => ({ query: r.keys[0] ?? '', clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));
}
