import { describe, expect, it } from 'vitest';
import { extractJson } from '../src/pipeline/askJson.js';
import { OpenAiCompatProvider } from '../src/providers/openai.js';

const noWait = { sleep: async () => undefined, random: () => 1 };
const req = { task: 'draft' as const, system: 's', prompt: 'p', maxTokens: 1000 };

const answer = (content: string | null, finish = 'stop') =>
  ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => '',
    json: async () => ({ choices: [{ message: { content }, finish_reason: finish }] }),
  }) as unknown as Response;

/** A fake web call that hands out the given answers and records the reply limit asked for each time. */
function fake(answers: Response[]) {
  const limits: number[] = [];
  const fetchFn = (async (_url: unknown, init?: { body?: string }) => {
    limits.push(JSON.parse(init!.body!).max_tokens);
    return answers.shift()!;
  }) as unknown as typeof fetch;
  return { fetchFn, limits };
}

describe('replies that run out of room', () => {
  it('asks again with double the room when a thinking model uses it all up', async () => {
    const f = fake([answer('', 'length'), answer('{"ok":true}')]);
    const p = new OpenAiCompatProvider('k', 'm', 'https://x.test/v1', f.fetchFn, noWait);
    expect(await p.complete(req)).toBe('{"ok":true}');
    expect(f.limits).toEqual([1000, 2000]);
  });
  it('widens at most twice, then says plainly what happened', async () => {
    const f = fake([answer('', 'length'), answer('', 'length'), answer('', 'length')]);
    const p = new OpenAiCompatProvider('k', 'm', 'https://x.test/v1', f.fetchFn, noWait);
    await expect(p.complete(req)).rejects.toThrow(/used its whole reply limit \(4000 tokens\).*thinking/);
    expect(f.limits).toEqual([1000, 2000, 4000]);
  });
  it('never asks for more than the ceiling', async () => {
    const f = fake([answer('', 'length'), answer('', 'length'), answer('', 'length')]);
    const p = new OpenAiCompatProvider('k', 'm', 'https://x.test/v1', f.fetchFn, noWait);
    await expect(p.complete({ ...req, maxTokens: 10_000 })).rejects.toThrow('16000 tokens');
    expect(Math.max(...f.limits)).toBe(16_000);
  });
  it('hands back a partly written reply instead of throwing, so the caller can ask again', async () => {
    const f = fake([answer('{"title":"cut', 'length'), answer('{"title":"cut', 'length'), answer('{"title":"cut', 'length')]);
    const p = new OpenAiCompatProvider('k', 'm', 'https://x.test/v1', f.fetchFn, noWait);
    expect(await p.complete(req)).toBe('{"title":"cut');
  });
  it('does not ask twice when the reply finished normally', async () => {
    const f = fake([answer('hello')]);
    const p = new OpenAiCompatProvider('k', 'm', 'https://x.test/v1', f.fetchFn, noWait);
    expect(await p.complete(req)).toBe('hello');
    expect(f.limits).toEqual([1000]);
  });
  it('treats an empty reply that finished normally as empty, not as an error', async () => {
    const f = fake([answer(null, 'stop')]);
    const p = new OpenAiCompatProvider('k', 'm', 'https://x.test/v1', f.fetchFn, noWait);
    expect(await p.complete(req)).toBe('');
  });
});

describe('saying what came back when there is no JSON', () => {
  it('names an empty reply', () => {
    expect(() => extractJson('')).toThrow(/no JSON object \(the reply was empty\)/);
  });
  it('shows how a prose reply began', () => {
    expect(() => extractJson('Sure! Here is the article you asked for:\n\n# Title')).toThrow(/starting: "Sure! Here is the article/);
  });
});
