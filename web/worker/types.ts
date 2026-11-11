export type Fetch = typeof fetch;

/** What Cloudflare gives the Worker. SUPABASE_URL is a public address (set in wrangler.jsonc); SUPABASE_SERVICE_KEY is a SECRET added in the Cloudflare dashboard. */
export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
  /** The built inbox page. Anything that is not /api/... goes here. */
  ASSETS: { fetch(request: Request): Promise<Response> };
}

/** Things tests replace: the network and the clock. */
export interface Deps {
  fetch?: Fetch;
  now?: () => Date;
}
