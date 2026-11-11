import { describe, expect, it } from 'vitest';
import { writeDraft } from '../src/pipeline/draft.js';
import { checkDraft } from '../src/pipeline/quality.js';
import { renderSources } from '../src/proof.js';
import type { Draft } from '../src/types.js';

const profile = { name: 'N', tone: 't', siteUrl: 'https://x', wordRange: { min: 1, max: 9999 }, minInternalLinks: 0, internalLinks: [], bannedClaims: [] } as never;
const topic = { title: 'T', slug: 's', keyword: 'kw', intent: 'i', outline: ['a', 'b', 'c'] };
const claim = (n: number) => `On Tuesday ${n} orders were refunded within 3 hours by the warehouse team.`;
const draftOf = (body: string): Draft => ({ topic, title: 'Title here', description: 'd'.repeat(80), body, tags: [], sources: [{ title: 'S', url: 'u', snippet: 'unrelated words only', fullText: 'unrelated words only' }] });
const block = /sentences with numbers do not match/;

describe('several unmatched number sentences block a draft', () => {
  it('blocks at three', () => {
    const r = checkDraft(draftOf([claim(11), claim(12), claim(13)].join(' ')), profile);
    expect(r.issues.join()).toMatch(block);
    expect(r.passed).toBe(false);
  });
  it('two stay as advice only', () => {
    const r = checkDraft(draftOf([claim(11), claim(12)].join(' ')), profile);
    expect(r.issues.join()).not.toMatch(block);
    expect(r.warnings.length).toBeGreaterThanOrEqual(2);
  });
  it('is not applied to practice (mock) drafts', () => {
    const r = checkDraft(draftOf([claim(11), claim(12), claim(13)].join(' ')), profile, { skipLength: true });
    expect(r.issues.join()).not.toMatch(block);
  });
});

describe('demo figures in the writing prompt', () => {
  it('tells the AI to copy counts exactly and mention adjustable settings', async () => {
    let system = '';
    const llm = { name: 'x', complete: async (r: { system: string }) => ((system = r.system), JSON.stringify({ title: 'Title here', description: 'd'.repeat(80), body: 'b'.repeat(50), tags: [] })) };
    await writeDraft(profile, topic, [], llm);
    expect(system).toContain('copy the counts exactly');
    expect(system).toContain('changing it changes the results');
  });
});

describe('source text record', () => {
  it('lists the full text of each source, falling back to the snippet', () => {
    const d = draftOf('x');
    d.sources = [{ title: 'A', url: 'ua', snippet: 'snip', fullText: 'the whole page' }, { title: 'B', url: 'ub', snippet: 'only snippet' }];
    const out = renderSources(d);
    expect(out).toContain('the whole page');
    expect(out).not.toContain('snip\n');
    expect(out).toContain('only snippet');
    expect(out).toContain('ub');
  });
});
