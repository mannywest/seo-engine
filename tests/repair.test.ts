import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import profileJson from '../clients/plerosis.json' with { type: 'json' };
import { unsupportedClaims } from '../src/pipeline/quality.js';
import { acceptableRepair, repairFigures, unsupportedFigures } from '../src/pipeline/repair.js';
import { runPipeline } from '../src/pipeline/run.js';
import type { ClientProfile, Draft } from '../src/types.js';

const profile = profileJson as ClientProfile;
const topic = { title: 'T', slug: 's', keyword: 'k', intent: 'i', outline: ['a', 'b', 'c'] };
const before = 'We handle the standard 80% and people handle the rest. See [work](/what-we-do).\n\n## One\n\nMore text here that stays the same for the whole article body.';
const fixed = 'We handle the routine work and people handle the rest. See [work](/what-we-do).\n\n## One\n\nMore text here that stays the same for the whole article body.';
const draftOf = (body: string): Draft => ({ topic, title: 'Title here', description: 'd'.repeat(80), body, tags: [], sources: [] });
const llmSaying = (...replies: string[]) => ({ name: 'x', complete: async () => replies.shift() ?? '' });
const reply = (body: string) => JSON.stringify({ body });

describe('claim check judges each line on its own', () => {
  it('does not glue a list lead-in to its first item', () => {
    const body = 'At the default 90% setting, the demo routes:\n5 invoices to be processed automatically.\n7 invoices to be sent to a person.';
    const d = { ...draftOf(body), sources: [{ title: 'S', url: 'u', snippet: 'demo', fullText: 'demo twelve invoices' }] };
    expect(unsupportedClaims(d)).toEqual([]);
  });
  it('still flags a real unsupported sentence', () => {
    const body = 'Letting software handle the standard 80 percent while people handle the messy 20 percent is practical and cheap.';
    expect(unsupportedClaims({ ...draftOf(body), sources: [{ title: 'S', url: 'u', snippet: 'x', fullText: 'unrelated words only' }] }).length).toBe(1);
  });
});

describe('figure repair', () => {
  it('reads the figures out of quality issues', () => {
    expect(unsupportedFigures(['Figure "80%" is not supported by any source.', 'Too short', 'Figure "£5" is not supported by any source.'])).toEqual(['80%', '£5']);
  });
  it('accepts a clean repair', async () => {
    const d = draftOf(before);
    expect((await repairFigures(d, ['80%'], llmSaying(reply(fixed)))).body).toBe(fixed);
  });
  it('rejects a repair that keeps the figure, adds one, drops a link or heading, or cuts too much', () => {
    expect(acceptableRepair(before, before, ['80%'])).toBe(false);
    expect(acceptableRepair(before, fixed + ' It saves 30%.', ['80%'])).toBe(false);
    expect(acceptableRepair(before, fixed.replace('[work](/what-we-do)', 'work'), ['80%'])).toBe(false);
    expect(acceptableRepair(before, fixed.replace('## One', 'One'), ['80%'])).toBe(false);
    expect(acceptableRepair(before, 'Short.', ['80%'])).toBe(false);
    expect(acceptableRepair(before, fixed, ['80%'])).toBe(true);
  });
  it('repairFigures refuses a repair that adds a new figure', async () => {
    const d = draftOf(before);
    expect(await repairFigures(d, ['80%'], llmSaying(reply(fixed + ' It saves 30%.')))).toBe(d);
  });
  it('keeps the original when the AI fails or replies badly', async () => {
    const d = draftOf(before);
    expect(await repairFigures(d, ['80%'], { name: 'x', complete: async () => { throw new Error('down'); } })).toBe(d);
    expect(await repairFigures(d, ['80%'], llmSaying('not json', 'still not json'))).toBe(d);
  });
});

describe('repair inside a live run', () => {
  const filler = 'Plain words about the work we do for small firms every single day. '.repeat(40);
  const body = (extra: string) =>
    [`Direct answer paragraph. ${filler}${extra}`, '## First', `See [what we do](/what-we-do). ${filler}`, '## Second', `Read [how we work](/how-we-work). ${filler}`, '## Third', filler, '## Frequently asked questions', '**Question?** Answer.'].join('\n\n');
  const topicJson = JSON.stringify({ topics: [{ title: 'A fresh topic title', keyword: 'fresh topic', intent: 'info', outline: ['a', 'b', 'c'] }] });
  const source = { search: async () => [{ title: 'S', url: 'https://example.com/s', snippet: 'plain words', fullText: 'plain words about the work' }], name: 'fake' };
  const run = async (answers: Record<string, string[]>) => {
    const calls: string[] = [];
    const llm = {
      name: 'fake',
      complete: async (r: { task: string; system: string }) => {
        const key = r.system.includes('careful editor') ? 'repair' : r.system.includes('You are an editor') ? 'rewrite' : r.task;
        calls.push(key);
        return (answers[key] ?? []).shift() ?? '';
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'repair-'));
    const [res] = await runPipeline({ ...profile, minInternalLinks: 2 }, llm, source, { count: 1, outDir: join(dir, 'out'), mock: false });
    return { res: res!, calls, text: await readFile(res!.path, 'utf8') };
  };
  const draftJson = (b: string) => JSON.stringify({ title: 'Fresh topic title here', description: 'A description about the fresh topic that sits comfortably between seventy and one hundred sixty characters.', body: b, tags: [] });

  it('removes an unsupported figure and keeps the better draft', async () => {
    const bad = body(' We let software take the standard 80% of the work.');
    const good = body(' We let software take the routine work.');
    const { res, calls, text } = await run({ plan: [topicJson], draft: [draftJson(bad)], repair: [reply(good)] });
    expect(calls).toContain('repair');
    expect(text).not.toContain('80%');
    expect(res.quality.issues.join()).not.toContain('80%');
  });
  it('keeps the original when the repair does not help', async () => {
    const bad = body(' We let software take the standard 80% of the work.');
    const { res, text } = await run({ plan: [topicJson], draft: [draftJson(bad)], repair: [reply(bad)] });
    expect(text).toContain('80%');
    expect(res.quality.issues.join()).toContain('80%');
  });
  it('does not call the repair when nothing is unsupported', async () => {
    const { calls } = await run({ plan: [topicJson], draft: [draftJson(body(''))] });
    expect(calls).not.toContain('repair');
  });
});
