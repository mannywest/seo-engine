import { mkdtemp } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import profileJson from '../clients/plerosis.json' with { type: 'json' };
import { FolderConnector } from '../src/connectors/folder.js';
import { History } from '../src/history.js';
import { notify } from '../src/notify.js';
import { runPipeline } from '../src/pipeline/run.js';
import { OpenAiCompatProvider } from '../src/providers/openai.js';
import { chooseLlm } from '../src/providers/choose.js';
import { MockProvider } from '../src/providers/llm.js';
import { MockSearch } from '../src/providers/search.js';
import { fetchGscQueries, buildJwt } from '../src/seo/gscApi.js';
import { connectorAdvice, detectPlatform, onboardSite } from '../src/seo/onboard.js';
import { summarisePsi } from '../src/seo/pagespeed.js';
import { checkDraft } from '../src/pipeline/quality.js';
import type { ClientProfile } from '../src/types.js';
import type { FetchResult } from '../src/seo/crawl.js';

const profile = profileJson as ClientProfile;

describe('run history', () => {
  it('is due on first run, then respects cadence', () => {
    const h = new History([], 'x');
    expect(h.isDue(2)).toBe(true);
    h.add({ slug: 'a', title: 'a', keyword: 'k', createdAt: '2026-11-01T00:00:00Z', passed: true, score: 90 });
    expect(h.isDue(2, new Date('2026-11-02T00:00:00Z'))).toBe(false);
    expect(h.isDue(2, new Date('2026-11-05T00:00:00Z'))).toBe(true);
    expect(h.isDue(0, new Date('2027-01-01'))).toBe(false);
  });
  it('persists across runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'seo-'));
    const h = await History.load('c1', dir);
    h.add({ slug: 'a', title: 'a', keyword: 'k', createdAt: new Date().toISOString(), passed: true, score: 1 });
    await h.save();
    expect((await History.load('c1', dir)).slugs()).toEqual(['a']);
  });
  it('stops a pipeline repeating slugs from earlier runs', async () => {
    const out = await mkdtemp(join(tmpdir(), 'seo-'));
    const history = new History([], 'x');
    const a = await runPipeline(profile, new MockProvider(), new MockSearch(), { count: 1, outDir: out, mock: true, history });
    expect(history.slugs()).toContain(a[0]!.slug);
    const other = await mkdtemp(join(tmpdir(), 'seo-'));
    const b = await runPipeline(profile, new MockProvider(), new MockSearch(), { count: 1, outDir: other, mock: true, history });
    expect(b.every((r) => r.slug !== a[0]!.slug)).toBe(true);
  });
});

describe('delivery gating', () => {
  it('only delivers drafts that passed (never in mock mode)', async () => {
    const out = await mkdtemp(join(tmpdir(), 'seo-'));
    const dest = await mkdtemp(join(tmpdir(), 'seo-'));
    const r = await runPipeline(profile, new MockProvider(), new MockSearch(), { count: 1, outDir: out, mock: true, connector: new FolderConnector(dest) });
    expect(r[0]!.deliveredTo).toBeUndefined();
  });
});

describe('quality: image alt text', () => {
  it('flags images with no alt', () => {
    const d = {
      topic: { title: 't', slug: 's', keyword: 'k', intent: 'i', outline: ['a', 'b', 'c'] },
      title: 'T', description: 'x'.repeat(80), body: '![](/a.png)\n\n## A\n## B\n## C\n## FAQ', tags: [], sources: [],
    };
    expect(checkDraft(d, profile, { skipLength: true }).issues.join(' ')).toMatch(/alt text/);
  });
});

describe('notify', () => {
  it('does nothing without a webhook and posts with one', async () => {
    expect(await notify('x', {})).toBe(false);
    let body = '';
    const f = (async (_u: string, init: RequestInit) => {
      body = init.body as string;
      return { ok: true } as Response;
    }) as unknown as typeof fetch;
    expect(await notify('boom', { NOTIFY_WEBHOOK_URL: 'https://h' }, f)).toBe(true);
    expect(body).toContain('boom');
  });
});

describe('llm choice', () => {
  it('explains missing keys and unknown names', () => {
    expect(() => chooseLlm({ llm: 'gemini' }, {})).toThrow(/GEMINI_API_KEY/);
    expect(() => chooseLlm({ llm: 'nope' }, {})).toThrow(/Unknown/);
    expect(chooseLlm({ llm: 'groq' }, { GROQ_API_KEY: 'k' }).name).toBe('groq');
  });
  it('openai-compatible provider reads the reply', async () => {
    const f = (async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) })) as unknown as typeof fetch;
    expect(await new OpenAiCompatProvider('k', 'm', 'https://x/v1', f).complete({ task: 'plan', system: '', prompt: '', maxTokens: 5 })).toBe('hi');
  });
});

describe('pagespeed', () => {
  it('rates vitals and prefers field data', () => {
    const r = summarisePsi('https://x.com', 'mobile', {
      lighthouseResult: { categories: { performance: { score: 0.61 } }, audits: { 'largest-contentful-paint': { numericValue: 1000 }, 'cumulative-layout-shift': { numericValue: 0.3 } } },
      loadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 4500 }, INTERACTION_TO_NEXT_PAINT: { percentile: 150 } } },
    });
    expect(r.performanceScore).toBe(61);
    expect(r.ratings).toEqual({ lcp: 'poor', inp: 'good', cls: 'poor' });
    expect(r.advice.length).toBe(2);
  });
});

describe('search console api', () => {
  it('signs a JWT and maps rows', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const sa = { client_email: 'bot@x.iam.gserviceaccount.com', private_key: privateKey };
    expect(buildJwt(sa).split('.')).toHaveLength(3);
    const f = (async (u: string) =>
      u.includes('oauth2') ? ({ ok: true, json: async () => ({ access_token: 't' }) } as Response) : ({ ok: true, status: 200, json: async () => ({ rows: [{ keys: ['ai seo'], clicks: 3, impressions: 100, ctr: 0.03, position: 8.2 }] }) } as Response)) as unknown as typeof fetch;
    const rows = await fetchGscQueries('sc-domain:x.com', { env: { GSC_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) }, fetchFn: f });
    expect(rows).toEqual([{ query: 'ai seo', clicks: 3, impressions: 100, ctr: 0.03, position: 8.2 }]);
  });
});

describe('onboarding', () => {
  it('detects platforms', () => {
    expect(detectPlatform('<link href="/wp-content/x.css">')).toBe('wordpress');
    expect(detectPlatform('<meta name="generator" content="Astro v4">')).toBe('astro');
    expect(detectPlatform('<script src="https://cdn.shopify.com/x.js">')).toBe('shopify');
    expect(connectorAdvice('astro').connector).toBe('git');
    expect(connectorAdvice('wix').connector).toBe('webhook');
  });
  it('refuses to write a profile for an unreachable site', async () => {
    const down = async (): Promise<FetchResult> => {
      throw new Error('connect failed');
    };
    await expect(onboardSite('https://down.test', { fetcher: down })).rejects.toThrow(/Could not read/);
  });
  it('builds a profile from a fake site', async () => {
    const home = `<html lang="en"><head><title>Acme Plumbing | Leeds</title><meta name="description" content="Emergency and routine plumbing for homes in Leeds."><link href="/wp-content/a.css"></head>
      <body><nav><a href="/services">Services</a><a href="/about">About us</a><a href="/contact">Contact</a></nav><h1>Acme Plumbing</h1><h2>Boiler repair</h2><h2>Leak detection</h2><p>We fix pipes fast.</p></body></html>`;
    const pages: Record<string, string> = { 'https://acme.test/': home, 'https://acme.test/services': '<html><head><title>S</title></head><body><h1>S</h1></body></html>' };
    const fetcher = async (url: string): Promise<FetchResult> => {
      const body = pages[url];
      return body ? { status: 200, body, contentType: 'text/html' } : { status: 404, body: '', contentType: '' };
    };
    const r = await onboardSite('https://acme.test', { fetcher });
    expect(r.profile.id).toBe('acme');
    expect(r.profile.name).toBe('Acme Plumbing');
    expect(r.profile.services).toEqual(['Boiler repair', 'Leak detection']);
    expect(r.profile.internalLinks.map((l) => l.url)).toContain('/services');
    expect(r.platform).toBe('wordpress');
    expect(r.profile.publish.mode).toBe('review');
    expect(r.review.join(' ')).toMatch(/keywords/);
  });
});
