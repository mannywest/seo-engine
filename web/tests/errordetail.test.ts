import { describe, expect, it } from 'vitest';
import { handle } from '../worker/index';

const KEY = 'sb_secret_TESTONLYKEY';
const env = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_KEY: KEY, ASSETS: { fetch: async () => new Response('page') } };

/** Sign-in check passes, then every database call fails with a body that must never be repeated. */
const failing = async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  if (url.includes('/auth/v1/user')) return new Response(JSON.stringify({ id: 'u1', email: 'a@b.c' }), { status: 200 });
  return new Response(JSON.stringify({ message: 'SECRET-BODY-TEXT', hint: KEY }), { status: 404 });
};

describe('server errors', () => {
  it('say which step failed and with what status, and nothing from the reply body or the key', async () => {
    const res = await handle(new Request('https://inbox.test/api/connect/config', { headers: { authorization: 'Bearer jwt' } }), env, { fetch: failing });
    expect(res.status).toBe(500);
    const text = await res.text();
    const { error, code } = JSON.parse(text) as { error: string; code: string };
    expect(code).toBe('server');
    expect(error).toMatch(/Something went wrong on our side\. Please try again\. \(Database .* failed \(404\)\)/);
    expect(text).not.toContain('SECRET-BODY-TEXT');
    expect(text).not.toContain(KEY);
  });

  it('names the kind of slip for a coding error, and blanks out the key if it appears', async () => {
    const boom = async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes('/auth/v1/user')) throw new TypeError(`bad thing with ${KEY}`);
      return new Response('{}', { status: 200 });
    };
    const res = await handle(new Request('https://inbox.test/api/connect/config', { headers: { authorization: 'Bearer jwt' } }), env, { fetch: boom });
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).toContain('TypeError');
    expect(text).toContain('[hidden]');
    expect(text).not.toContain(KEY);
  });
});
