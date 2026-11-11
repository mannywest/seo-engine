import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { ConnectApi, ConnectApiError, GITHUB_AUTHORIZE, GITHUB_NEW_APP, postManifest, readNotice, safeGithubUrl } from '../src/connectApi';
import { REASONS } from '../src/reasons';
import { articleFileName, articleMarkdown, canTakeAway } from '../src/share';

const signedIn = { auth: { getSession: async () => ({ data: { session: { access_token: 'tok-123' } } }) } } as unknown as SupabaseClient;
const signedOut = { auth: { getSession: async () => ({ data: { session: null } }) } } as unknown as SupabaseClient;

type Seen = { url: string; init: RequestInit };
function fakeFetch(reply: (url: string) => { status?: number; body?: unknown } | Error) {
  const seen: Seen[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    seen.push({ url, init });
    const r = reply(url);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe('the Connect API caller', () => {
  it('carries the person’s own sign-in as a bearer token and sends JSON for writes', async () => {
    const { f, seen } = fakeFetch(() => ({ body: { ready: true, admin: false } }));
    const api = new ConnectApi(signedIn, f);
    expect(await api.config()).toEqual({ ready: true, admin: false });
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
    expect(seen[0]!.init.method).toBe('GET');
    const w = fakeFetch(() => ({ body: { ok: true } }));
    await new ConnectApi(signedIn, w.f).disconnect('acme');
    expect(w.seen[0]!.init.method).toBe('POST');
    expect(w.seen[0]!.init.body).toBe(JSON.stringify({ clientId: 'acme' }));
  });

  it('asks the person to sign in again instead of calling the server without a token', async () => {
    const { f, seen } = fakeFetch(() => ({}));
    await expect(new ConnectApi(signedOut, f).config()).rejects.toThrow('Please sign in again.');
    expect(seen).toHaveLength(0);
  });

  it('shows the server’s plain-English message, and a kind one for a network failure', async () => {
    const bad = fakeFetch(() => ({ status: 403, body: { error: 'Only the owner of the business can connect its website.' } }));
    await expect(new ConnectApi(signedIn, bad.f).startGithub('acme')).rejects.toThrow('Only the owner');
    const down = fakeFetch(() => new Error('boom'));
    await expect(new ConnectApi(signedIn, down.f).pending('acme')).rejects.toThrow(/Could not reach the server/);
    const odd = fakeFetch(() => ({ status: 500, body: {} }));
    await expect(new ConnectApi(signedIn, odd.f).pending('acme')).rejects.toThrow(/Something went wrong \(500\)/);
  });

  it('treats "the site has no server settings" as a state to show, not an error', async () => {
    const { f } = fakeFetch(() => ({ status: 503, body: { error: 'x', code: 'not_configured' } }));
    expect(await new ConnectApi(signedIn, f).config()).toEqual({ ready: false, admin: false, notConfigured: true });
    const other = fakeFetch(() => ({ status: 503, body: { error: 'x', code: 'app_missing' } }));
    await expect(new ConnectApi(signedIn, other.f).config()).rejects.toBeInstanceOf(ConnectApiError);
  });

  it('only follows a reply that sends the person to GitHub itself', async () => {
    const good = fakeFetch(() => ({ body: { url: `${GITHUB_AUTHORIZE}client_id=x&state=y` } }));
    expect(await new ConnectApi(signedIn, good.f).startGithub('acme')).toContain('https://github.com/login/oauth/authorize?');
    for (const url of ['https://evil.example/login/oauth/authorize?x', 'http://github.com/login/oauth/authorize?x', 'https://github.com.evil.test/login/oauth/authorize?x', 'javascript:alert(1)', undefined, 42]) {
      const bad = fakeFetch(() => ({ body: { url } }));
      await expect(new ConnectApi(signedIn, bad.f).startGithub('acme')).rejects.toThrow(/unexpected address/);
    }
  });

  it('will not hand the app description to anywhere but GitHub’s create-app screen', async () => {
    const bad = fakeFetch(() => ({ body: { action: 'https://evil.example/settings/apps/new?state=x', manifest: {} } }));
    await expect(new ConnectApi(signedIn, bad.f).prepareApp()).rejects.toThrow(/unexpected address/);
    expect(() => postManifest('https://evil.example/settings/apps/new?state=x', {})).toThrow(/anywhere but GitHub/);
    expect(safeGithubUrl(`${GITHUB_NEW_APP}abc`, GITHUB_NEW_APP)).toBe(true);
    expect(safeGithubUrl('https://github.com/settings/apps/new', GITHUB_NEW_APP)).toBe(false);
  });
});

describe('coming back from GitHub', () => {
  it('reads what happened from the address', () => {
    expect(readNotice('?connect=pick')).toEqual({ kind: 'pick' });
    expect(readNotice('?connect=error&reason=denied')).toEqual({ kind: 'error', text: REASONS.denied });
    expect(readNotice('?app=created')).toEqual({ kind: 'app-created' });
    expect(readNotice('?app=error&reason=app_exists')).toEqual({ kind: 'app-error', text: REASONS.app_exists });
  });
  it('shows a safe message for an unknown reason, and nothing for an ordinary visit', () => {
    expect(readNotice('?connect=error&reason=<script>')).toEqual({ kind: 'error', text: REASONS.server });
    expect(readNotice('')).toBeUndefined();
    expect(readNotice('?utm_source=x')).toBeUndefined();
  });
});

describe('copy and download', () => {
  const item = { id: 'a-1', title: 'Why "AI" helps', description: 'A short one.', tags: ['ai', 'small business'], body: '\n## Hello\n\nBody text.\n\n', topic: { slug: 'Why-AI helps!' } };
  it('makes a markdown file with front matter that stays valid when titles contain quotes', () => {
    expect(articleMarkdown(item)).toBe('---\ntitle: "Why \\"AI\\" helps"\ndescription: "A short one."\ntags: ["ai", "small business"]\n---\n\n## Hello\n\nBody text.\n');
    expect(articleMarkdown({ ...item, tags: [] })).not.toContain('tags:');
  });
  it('names the file safely from the slug, falling back to the id, then to "article"', () => {
    expect(articleFileName(item)).toBe('why-ai-helps.md');
    expect(articleFileName({ id: 'Id 9', topic: { slug: '' } })).toBe('id-9.md');
    expect(articleFileName({ id: '', topic: { slug: '../../etc/passwd' } })).toBe('etc-passwd.md');
    expect(articleFileName({ id: '!!!', topic: { slug: '' } })).toBe('article.md');
  });
  it('only offers it once the person has approved the article', () => {
    expect(canTakeAway('waiting')).toBe(false);
    expect(canTakeAway('rejected')).toBe(false);
    for (const s of ['approved', 'published', 'publish_failed'] as const) expect(canTakeAway(s)).toBe(true);
  });
});
