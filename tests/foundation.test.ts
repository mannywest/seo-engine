import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import profileJson from '../clients/plerosis.json' with { type: 'json' };
import { allowanceMeter, articlesRemaining, hasFeature, PLANS } from '../src/plans.js';
import { buildProof, renderProof } from '../src/proof.js';
import { MockProvider } from '../src/providers/llm.js';
import { buildReceipt } from '../src/receipt.js';
import { runClient } from '../src/runClient.js';
import { CapReachedError, MeteredProvider, UsageLog } from '../src/usage.js';
import type { ClientProfile } from '../src/types.js';

const profile = profileJson as ClientProfile;

describe('plans', () => {
  it('has the accepted prices', () => {
    expect([PLANS.local.priceGbp, PLANS.grow.priceGbp, PLANS.pro.priceGbp]).toEqual([59, 129, 249]);
  });
  it('gates features by plan', () => {
    expect(hasFeature('local', 'ai_search')).toBe(false);
    expect(hasFeature('pro', 'ai_search')).toBe(true);
    expect(hasFeature(undefined, 'proof_pack')).toBe(true);
  });
  it('meters allowance', () => {
    expect(allowanceMeter('local', { articles: 3, gbpPosts: 0 })[0]).toMatchObject({ remaining: 1 });
    expect(articlesRemaining('local', 10)).toBe(0);
  });
});

describe('usage metering', () => {
  const req = { task: 'draft' as const, system: 's', prompt: 'p'.repeat(400), maxTokens: 100 };
  it('records calls and enforces the monthly cap', async () => {
    const log = new UsageLog([], 'unused');
    const now = () => new Date('2026-11-10T00:00:00Z');
    const m = new MeteredProvider(new MockProvider(), log, { monthlyTokenCap: 150, now });
    await m.complete({ ...req, task: 'plan' });
    expect(log.entries).toHaveLength(1);
    expect(log.totalTokens('2026-11')).toBeGreaterThan(100);
    await m.complete(req).catch(() => undefined);
    await expect(m.complete(req)).rejects.toBeInstanceOf(CapReachedError);
  });
});

describe('proof pack and receipt', () => {
  it('builds a proof pack with a stable fingerprint', () => {
    const draft = {
      topic: { title: 't', slug: 't', keyword: 'k', intent: 'i', outline: [] },
      title: 'T',
      description: 'd',
      body: 'hello',
      tags: [],
      sources: [{ title: 'S', url: 'https://x.test', snippet: '' }],
    };
    const q = { passed: true, score: 100, issues: [], warnings: [] };
    const a = buildProof(draft, q, profile, 'mock');
    expect(a.bodySha256).toBe(buildProof(draft, q, profile, 'mock').bodySha256);
    expect(renderProof(a)).toContain('https://x.test');
  });
  it('writes a plain-English receipt', () => {
    const r = buildReceipt({
      clientName: 'Acme',
      month: '2026-11',
      plan: 'local',
      history: [
        { slug: 'a', title: 'A', keyword: 'k', createdAt: '2026-11-02T00:00:00Z', passed: true, score: 90, deliveredTo: 'PR #1' },
        { slug: 'b', title: 'B', keyword: 'k', createdAt: '2026-11-03T00:00:00Z', passed: false, score: 50 },
        { slug: 'c', title: 'C', keyword: 'k', createdAt: '2026-10-03T00:00:00Z', passed: true, score: 90 },
      ],
    });
    expect(r).toContain('Articles written: 2');
    expect(r).toContain('1 of 4 used, 3 left');
    expect(r).toContain('do not promise rankings');
  });
});

describe('runClient integration', () => {
  it('stops at the plan allowance and logs usage in live mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'seo-'));
    const p = { ...profile, plan: 'local' as const };
    let n = 0;
    const run = () => {
      const id = ++n;
      const mock = new MockProvider();
      const llm = { name: 'mock', complete: async (r: Parameters<MockProvider['complete']>[0]) => (await mock.complete(r)).replace(/Topic/g, `Run${id} Topic`) };
      return runClient(p, { live: true, llm: { provider: 'anthropic' } as never, count: 3, outDir: join(dir, 'out'), dataDir: dir, sourcesDir: join(dir, 'src'), llmProvider: llm });
    };
    const first = await run();
    expect(first.length).toBe(3);
    expect((await readdir(join(dir, 'out.proofs'))).some((f) => f.endsWith('.proof.md'))).toBe(true);
    expect(JSON.parse(await readFile(join(dir, p.id, 'usage.json'), 'utf8')).length).toBeGreaterThan(0);
    const second = await run(); // 3 used, 1 left on Local
    expect(second.length).toBe(1);
    expect(await run()).toEqual([]);
  });
});
