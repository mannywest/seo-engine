import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { FileInboxStore } from '../src/inbox.js';
import { InboxConfigError, inboxClientFiles, openInbox } from '../src/inboxOpen.js';
import { SupabaseInboxStore } from '../src/inboxSupabase.js';

const tmp = () => mkdtemp(join(tmpdir(), 'open-'));

describe('choosing where the inbox lives', () => {
  it('uses the local file when nothing is set, and treats blank values as not set', async () => {
    const dir = await tmp();
    expect(await openInbox('c1', { dataDir: dir, env: {} })).toBeInstanceOf(FileInboxStore);
    expect(await openInbox('c1', { dataDir: dir, env: { SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '  ' } })).toBeInstanceOf(FileInboxStore);
    expect(await openInbox('c1', { dataDir: dir, env: { SUPABASE_URL: '  ', SUPABASE_SERVICE_KEY: '\n' } })).toBeInstanceOf(FileInboxStore);
    expect(await openInbox('c1', { dataDir: dir, env: { SUPABASE_URL: ' ', SUPABASE_SERVICE_KEY: '' } })).toBeInstanceOf(FileInboxStore);
  });
  it('uses Supabase for the right client when both are set', async () => {
    const urls: string[] = [];
    const f = (async (u: string | URL | Request) => {
      urls.push(String(u));
      return new Response('[]', { status: 200 });
    }) as typeof fetch;
    const s = await openInbox('acme-1', { env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k' }, fetch: f });
    expect(s).toBeInstanceOf(SupabaseInboxStore);
    await s.list();
    expect(urls[0]).toContain('client_id=eq.acme-1');
  });
  it('half set up is an error that names what is missing, never a quiet fallback', async () => {
    await expect(openInbox('c', { env: { SUPABASE_URL: 'https://x.supabase.co' } })).rejects.toThrow(/SUPABASE_SERVICE_KEY is missing/);
    await expect(openInbox('c', { env: { SUPABASE_SERVICE_KEY: 'k', SUPABASE_URL: '' } })).rejects.toThrow(/SUPABASE_URL is missing/);
    await expect(openInbox('c', { env: { SUPABASE_URL: 'u' } })).rejects.toThrow(InboxConfigError);
  });
});

describe('which clients get their approved articles published', () => {
  async function clientsDir() {
    const dir = join(await tmp(), 'clients');
    await mkdir(dir);
    await writeFile(join(dir, 'b-on.json'), JSON.stringify({ id: 'b-on', publish: { inbox: true } }));
    await writeFile(join(dir, 'a-on.json'), JSON.stringify({ id: 'a-on', publish: { inbox: true } }));
    await writeFile(join(dir, 'off.json'), JSON.stringify({ id: 'off', publish: { mode: 'auto' } }));
    await writeFile(join(dir, 'false.json'), JSON.stringify({ id: 'false', publish: { inbox: false } }));
    await writeFile(join(dir, 'broken.json'), '{ not json');
    await writeFile(join(dir, 'notes.txt'), 'ignore me');
    return dir;
  }
  it('all: only clients with the inbox on, in a stable order, ignoring broken files', async () => {
    const dir = await clientsDir();
    expect(await inboxClientFiles(dir)).toEqual([join(dir, 'a-on.json'), join(dir, 'b-on.json')]);
  });
  it('one named client, even if its inbox is off (the person asked for it)', async () => {
    const dir = await clientsDir();
    expect(await inboxClientFiles(dir, 'off')).toEqual([join(dir, 'off.json')]);
  });
  it('refuses ids that could reach other folders or run commands, and missing clients', async () => {
    const dir = await clientsDir();
    for (const bad of ['../secrets', 'a/b', 'a;rm -rf', '$(id)', '', '-x', 'a b']) {
      await expect(inboxClientFiles(dir, bad)).rejects.toThrow(/not a valid client id/);
    }
    await expect(inboxClientFiles(dir, 'nobody')).rejects.toThrow(/no client file/);
  });
});

describe('the publish-approved command, run for real', () => {
  const run = promisify(execFile);
  it('with a half-set-up hosted inbox it stops with a clear message and a failing exit code', async () => {
    await expect(
      run('npx', ['tsx', 'src/cli.ts', 'publish-approved', 'plerosis'], { env: { ...process.env, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: '' } }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('SUPABASE_SERVICE_KEY is missing'), code: 1 });
  }, 60000);
  it('rejects an unsafe client id before touching anything', async () => {
    await expect(run('npx', ['tsx', 'src/cli.ts', 'publish-approved', '../x'])).rejects.toMatchObject({ stdout: expect.stringContaining('not a valid client id'), code: 1 });
  }, 60000);
});
