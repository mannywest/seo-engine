import { describe, expect, it } from 'vitest';
import { FallbackProvider } from '../src/providers/fallback.js';
import { chooseLlm } from '../src/providers/choose.js';
import type { LlmProvider } from '../src/providers/llm.js';
import { OpenAiCompatProvider } from '../src/providers/openai.js';
import { HttpError, isRetryableStatus, parseRetryAfter, withRetry } from '../src/retry.js';
import { runPageSpeed } from '../src/seo/pagespeed.js';

const noWait = { sleep: async () => undefined, random: () => 1 };
const req = { task: 'draft' as const, system: 's', prompt: 'p', maxTokens: 10 };

/** A fake web response. */
const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as unknown as Response;

describe('retry rules', () => {
  it('redials only busy and try-later answers', () => {
    for (const s of [408, 429, 500, 502, 503, 504]) expect(isRetryableStatus(s)).toBe(true);
    for (const s of [400, 401, 403, 404]) expect(isRetryableStatus(s)).toBe(false);
  });
  it('reads Retry-After as seconds or a date', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('Wed, 11 Nov 2026 00:00:10 GMT', Date.parse('2026-11-11T00:00:00Z'))).toBe(10_000);
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
  it('succeeds after busy answers, waiting longer each time', async () => {
    const waits: number[] = [];
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls += 1;
        if (calls < 4) throw new HttpError(503, 'busy');
        return 'ok';
      },
      { ...noWait, sleep: async (ms) => void waits.push(ms), baseMs: 1000 },
    );
    expect(out).toBe('ok');
    expect(calls).toBe(4);
    expect(waits).toEqual([1000, 2000, 4000]);
  });
  it('does not retry mistakes that trying again cannot fix', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls += 1;
        throw new HttpError(401, 'bad key');
      }, noWait),
    ).rejects.toThrow('bad key');
    expect(calls).toBe(1);
  });
  it('gives up after the set number of tries and throws the last error', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new HttpError(503, `busy ${calls}`);
        },
        { ...noWait, attempts: 3 },
      ),
    ).rejects.toThrow('busy 3');
    expect(calls).toBe(3);
  });
  it('waits as long as the service asks (within the cap)', async () => {
    const waits: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new HttpError(429, 'slow down', 7000);
        return 1;
      },
      { ...noWait, sleep: async (ms) => void waits.push(ms) },
    );
    expect(waits).toEqual([7000]);
  });
  it('retries when no answer comes back at all', async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return 'ok';
    }, noWait);
    expect(out).toBe('ok');
  });
});

describe('AI provider retries', () => {
  const good = { choices: [{ message: { content: 'hello' } }] };
  it('rides out an overloaded answer, as Gemini gave on 10 Nov 2026', async () => {
    const answers = [reply(503, { error: { status: 'UNAVAILABLE' } }), reply(503), reply(200, good)];
    const p = new OpenAiCompatProvider('k', 'm', 'https://x.test/v1', async () => answers.shift()!, noWait);
    expect(await p.complete(req)).toBe('hello');
    expect(answers).toHaveLength(0);
  });
  it('stops at once on a withdrawn model and keeps the service message', async () => {
    let calls = 0;
    const p = new OpenAiCompatProvider('k', 'm', 'https://x.test/v1', async () => (calls++, reply(404, { error: 'gone' })), noWait);
    await expect(p.complete(req)).rejects.toThrow(/LLM service returned 404/);
    expect(calls).toBe(1);
  });
});

describe('fallback between AIs', () => {
  const ai = (name: string, run: () => Promise<string>): LlmProvider => ({ name, complete: run });
  const quiet = () => undefined;
  it('passes on to the next AI when the first is overloaded', async () => {
    const seen: string[] = [];
    const f = new FallbackProvider(
      [ai('a', async () => { throw new HttpError(503, 'busy'); }), ai('b', async () => 'from b')],
      (from, to) => void seen.push(`${from}>${to}`),
    );
    expect(await f.complete(req)).toBe('from b');
    expect(seen).toEqual(['a>b']);
  });
  it('passes on when a model has been withdrawn (404)', async () => {
    const f = new FallbackProvider([ai('a', async () => { throw new HttpError(404, 'gone'); }), ai('b', async () => 'ok')], quiet);
    expect(await f.complete(req)).toBe('ok');
  });
  it('does not hide a wrong key behind a backup', async () => {
    let bCalled = false;
    const f = new FallbackProvider(
      [ai('a', async () => { throw new HttpError(401, 'bad key'); }), ai('b', async () => ((bCalled = true), 'ok'))],
      quiet,
    );
    await expect(f.complete(req)).rejects.toThrow('bad key');
    expect(bCalled).toBe(false);
  });
  it('throws the last error when every AI fails', async () => {
    const f = new FallbackProvider(
      [ai('a', async () => { throw new HttpError(503, 'a busy'); }), ai('b', async () => { throw new HttpError(429, 'b limited'); })],
      quiet,
    );
    await expect(f.complete(req)).rejects.toThrow('b limited');
  });
  it('builds a chain from --fallback and skips backups with no key', () => {
    const env = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' } as unknown as NodeJS.ProcessEnv;
    const chain = chooseLlm({ llm: 'gemini', fallback: ['groq', 'openrouter', 'gemini'] }, env);
    expect(chain.name).toBe('openai-compatible -> openai-compatible');
    const single = chooseLlm({ llm: 'gemini', fallback: ['openrouter'] }, env);
    expect(single.name).toBe('openai-compatible');
  });
});

describe('PageSpeed retries', () => {
  it('retries a 429 and then succeeds', async () => {
    const answers = [reply(429), reply(200, {})];
    const r = await runPageSpeed('https://x.test', 'mobile', { PAGESPEED_API_KEY: 'k' } as unknown as NodeJS.ProcessEnv, async () => answers.shift()!, noWait);
    expect(r.url).toBe('https://x.test');
    expect(answers).toHaveLength(0);
  });
  it('tells the owner about the free key when it keeps getting 429 without one', async () => {
    await expect(
      runPageSpeed('https://x.test', 'mobile', {} as unknown as NodeJS.ProcessEnv, async () => reply(429), { ...noWait, attempts: 2 }),
    ).rejects.toThrow(/PAGESPEED_API_KEY/);
  });
});
