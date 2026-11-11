import { describe, expect, it } from 'vitest';
import { acceptableRewrite, improveReadability } from '../src/pipeline/readability.js';
import { checkDraft, unsupportedClaims } from '../src/pipeline/quality.js';
import { rankDocs } from '../src/providers/sources.js';
import { writeDraft } from '../src/pipeline/draft.js';
import type { Draft } from '../src/types.js';

const hard = 'Organisational implementation necessitates comprehensive operationalisation of interdependent methodological considerations notwithstanding administrative complexity. '.repeat(4);
const easy = 'We check each invoice. Then we send it to a person. It is fast. It is safe. '.repeat(8);
const draftOf = (body: string, sources: Draft['sources'] = []): Draft => ({
  topic: { title: 't', slug: 's', keyword: 'k', intent: 'i', outline: [] }, title: 'Title here', description: 'd'.repeat(80), body, tags: [], sources,
});
const llmSaying = (...replies: string[]) => ({ name: 'x', complete: async () => replies.shift() ?? '' });

describe('full page text for figure checks', () => {
  const long = 'Intro words here. '.repeat(60) + 'Our invoices pass at 91% confidence.';
  it('rankDocs keeps the whole page beyond the snippet', () => {
    const [s] = rankDocs([{ title: 'T', url: 'u', paragraphs: [long] }], 'invoices', 1, 50);
    expect(s!.snippet.length).toBeLessThanOrEqual(50);
    expect(s!.fullText).toContain('91%');
  });
  it('a figure on the page but outside the snippet is not flagged', () => {
    const d = draftOf('We saw 91% confidence.', [{ title: 'T', url: 'u', snippet: 'Intro', fullText: long }]);
    expect(checkDraft(d, { wordRange: { min: 1, max: 9 }, minInternalLinks: 0, bannedClaims: [], siteUrl: 'https://x', name: 'n' } as never, { skipLength: true }).issues.join()).not.toContain('91%');
  });
  it('a figure nowhere on the page is still flagged', () => {
    const d = draftOf('We saw 77% confidence.', [{ title: 'T', url: 'u', snippet: 'Intro', fullText: long }]);
    expect(checkDraft(d, { wordRange: { min: 1, max: 9 }, minInternalLinks: 0, bannedClaims: [], siteUrl: 'https://x', name: 'n' } as never, { skipLength: true }).issues.join()).toContain('77%');
  });
  it('claim check also uses the full text', () => {
    const d = draftOf('The invoices pass at 91 percent confidence every single day.', [{ title: 'T', url: 'u', snippet: 'x', fullText: 'invoices pass confidence every single day percent' }]);
    expect(unsupportedClaims(d)).toEqual([]);
  });
});

describe('claim check ignores list scaffolding', () => {
  const src = [{ title: 'T', url: 'u', snippet: 'x', fullText: 'unrelated text only' }];
  it('does not flag a lead-in sentence followed by a numbered list', () => {
    const body = 'When determining where to place approval gates, consider these factors:\n\n1. Risk of harm\n2. Cost of a mistake';
    expect(unsupportedClaims(draftOf(body, src))).toEqual([]);
  });
  it('still flags a real unsupported figure', () => {
    const body = 'Our customers see a 73 percent increase in invoice approvals every single month.';
    expect(unsupportedClaims(draftOf(body, src)).length).toBe(1);
  });
});

describe('writing prompt asks for the keyword in the description', () => {
  it('names the exact keyword', async () => {
    let seen = '';
    const llm = {
      name: 'x',
      complete: async (r: { system: string }) => {
        seen = r.system;
        return JSON.stringify({ title: 'A good title', description: 'd'.repeat(80), body: 'Body text here that is long enough.', tags: [] });
      },
    };
    const topic = { title: 't', slug: 's', keyword: 'approval gates for ai', intent: 'i', outline: [] };
    await writeDraft({ name: 'n', tone: 't', wordRange: { min: 1, max: 9 }, minInternalLinks: 0, internalLinks: [], bannedClaims: [] } as never, topic, [], llm as never);
    expect(seen).toContain('description must contain the exact target keyword "approval gates for ai"');
  });
});

describe('readability rewrite', () => {
  it('leaves easy articles alone without calling the AI', async () => {
    const d = draftOf(easy);
    expect(await improveReadability(d, llmSaying('should not be used'))).toBe(d);
  });
  it('uses a clearly easier rewrite', async () => {
    const out = await improveReadability(draftOf(hard), llmSaying(JSON.stringify({ body: easy.repeat(2) })));
    expect(out.body).toBe(easy.repeat(2));
  });
  it('keeps the original when the rewrite is not easier', async () => {
    const d = draftOf(hard);
    const worse = hard + ' Furthermore interoperability considerations notwithstanding.';
    expect((await improveReadability(d, llmSaying(JSON.stringify({ body: worse })))).body).toBe(hard);
  });
  it('keeps the original when the AI fails', async () => {
    const d = draftOf(hard);
    const bad = { name: 'x', complete: async () => { throw new Error('down'); } };
    expect(await improveReadability(d, bad)).toBe(d);
  });
  it('rejects rewrites that lose a link, a figure, or a lot of text', () => {
    const before = hard + ' [a](/a) costs £50.';
    expect(acceptableRewrite(before, easy + ' costs £50.')).toBe(false);
    expect(acceptableRewrite(before, easy.repeat(2) + ' [a](/a)')).toBe(false);
    expect(acceptableRewrite(before, easy.repeat(2) + ' [a](/a) costs £50.')).toBe(true);
    expect(acceptableRewrite(before, easy.slice(0, 40) + ' [a](/a) costs £50.')).toBe(false);
  });
});
