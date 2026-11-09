import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import profileJson from '../clients/plerosis.json' with { type: 'json' };
import { checkDraft } from '../src/pipeline/quality.js';
import { runPipeline } from '../src/pipeline/run.js';
import { MockProvider } from '../src/providers/llm.js';
import { MockSearch } from '../src/providers/search.js';
import { buildLlmsTxt } from '../src/publish/llms.js';
import { slugify, toMarkdownFile } from '../src/publish/markdown.js';
import type { ClientProfile, Draft } from '../src/types.js';

const profile = profileJson as ClientProfile;

function goodDraft(): Draft {
  const filler = 'word '.repeat(300);
  const body = [
    `Direct answer paragraph. ${filler}`,
    '## First section',
    `See [what we do](/what-we-do). ${filler}`,
    '## Second section',
    `Read [how we work](/how-we-work). ${filler}`,
    '## Third section',
    filler,
    '## Frequently asked questions',
    '**Question?** Answer.',
  ].join('\n\n');
  return {
    topic: { title: 'A good title', slug: 'a-good-title', keyword: 'k', intent: 'info', outline: ['a', 'b', 'c'] },
    title: 'A good title',
    description: 'A meta description that is comfortably between seventy and one hundred and sixty characters long.',
    body,
    tags: [],
    sources: [{ title: 's', url: 'https://example.com', snippet: 'No figures here.' }],
  };
}

describe('quality check', () => {
  it('passes a good draft', () => {
    const r = checkDraft(goodDraft(), profile);
    expect(r.issues).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('flags banned claims', () => {
    const d = goodDraft();
    d.body += '\nThis is guaranteed to work.';
    expect(checkDraft(d, profile).issues.join(' ')).toMatch(/banned claim/);
  });

  it('flags figures that no source supports', () => {
    const d = goodDraft();
    d.body += '\nCompanies save 40% on costs.';
    expect(checkDraft(d, profile).issues.join(' ')).toMatch(/40%/);
  });

  it('accepts figures that a source supports', () => {
    const d = goodDraft();
    d.body += '\nThe survey found 40% of firms agreed.';
    d.sources[0]!.snippet = 'A survey found 40% of firms agreed.';
    expect(checkDraft(d, profile).issues).toEqual([]);
  });

  it('flags a missing FAQ, too few links and duplicate slugs', () => {
    const d = goodDraft();
    d.body = d.body.replace('## Frequently asked questions', '## Wrap up').replace(/\]\(\/[^)]+\)/g, '](https://other.com)');
    const text = checkDraft(d, profile, { existingSlugs: ['a-good-title'] }).issues.join(' ');
    expect(text).toMatch(/FAQ/);
    expect(text).toMatch(/internal links/);
    expect(text).toMatch(/already exists/);
  });

  it('flags drafts that are too short', () => {
    const d = goodDraft();
    d.body = '## A\n\nshort\n\n## B\n\nshort\n\n## C\n\n## FAQ\n\n[x](/what-we-do) [y](/how-we-work)';
    expect(checkDraft(d, profile).issues.join(' ')).toMatch(/Too short/);
  });
});

describe('markdown output', () => {
  it('slugifies titles', () => {
    expect(slugify('How AI Agents Help: A Guide & More!')).toBe('how-ai-agents-help-a-guide-and-more');
  });

  it('writes review-mode drafts with front matter', () => {
    const f = toMarkdownFile(goodDraft(), profile, new Date('2026-11-09T00:00:00Z'));
    expect(f.path).toBe('src/content/blog/a-good-title.md');
    expect(f.content).toContain('status: draft');
    expect(f.content).toContain('reviewed: false');
    expect(f.content).toContain('pubDate: 2026-11-09');
  });
});

describe('llms.txt', () => {
  it('lists key pages and articles', () => {
    const t = buildLlmsTxt(profile, [{ title: 'T', url: 'https://plerosis.com/blog/t', description: 'D' }]);
    expect(t).toContain('# Plerosis');
    expect(t).toContain('https://plerosis.com/what-we-do');
    expect(t).toContain('[T](https://plerosis.com/blog/t): D');
  });
});

describe('pipeline (mock mode, no cost)', () => {
  it('plans, drafts and writes markdown without repeating slugs', async () => {
    const out = await mkdtemp(join(tmpdir(), 'seo-'));
    const first = await runPipeline(profile, new MockProvider(), new MockSearch(), { count: 2, outDir: out, mock: true });
    expect(first).toHaveLength(2);
    expect(first.every((r) => r.quality.passed)).toBe(true);
    const files = await readdir(out);
    expect(files).toHaveLength(2);
    expect(await readFile(join(out, files[0]!), 'utf8')).toContain('generatedBy: seo-engine');
    const second = await runPipeline(profile, new MockProvider(), new MockSearch(), { count: 2, outDir: out, mock: true });
    expect(new Set([...first, ...second].map((r) => r.slug)).size).toBe(first.length + second.length);
  });
});
