import { describe, expect, it } from 'vitest';
import { FallbackProvider } from '../src/providers/fallback.js';
import type { LlmProvider } from '../src/providers/llm.js';
import { OpenAiCompatProvider } from '../src/providers/openai.js';
import { HttpError, isDailyQuota, parseRetryHint, withRetry } from '../src/retry.js';

const req = { task: 'draft' as const, system: 's', prompt: 'p', maxTokens: 100 };

const raw = (status: number, text: string) =>
  ({
    ok: status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
    json: async () => (text ? JSON.parse(text) : {}),
  }) as unknown as Response;

function setup(answers: Response[]) {
  const waits: number[] = [];
  let calls = 0;
  const fetchFn = (async () => (calls++, answers.shift()!)) as unknown as typeof fetch;
  const provider = new OpenAiCompatProvider('k', 'm', 'https://x.test/v1', fetchFn, { sleep: async (ms) => void waits.push(ms), random: () => 1 });
  return { provider, waits, calls: () => calls };
}

const ok = JSON.stringify({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] });
const perMinute = 'You exceeded your current quota. Please retry in 3.5s.';
const perDay = 'You exceeded your current quota. quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier';

describe('reading quota messages', () => {
  it('finds the wait the service asks for', () => {
    expect(parseRetryHint('Please retry in 12.3s.')).toBe(12_300);
    expect(parseRetryHint('{"retryDelay": "7s"}')).toBe(7000);
    expect(parseRetryHint('nothing here')).toBeUndefined();
  });
  it('spots a quota that resets once a day', () => {
    expect(isDailyQuota(perDay)).toBe(true);
    expect(isDailyQuota(perMinute)).toBe(false);
  });
});

describe('quota errors from the AI service', () => {
  it('waits as long as the service asks, then succeeds', async () => {
    const s = setup([raw(429, perMinute), raw(200, ok)]);
    expect(await s.provider.complete(req)).toBe('hello');
    expect(s.waits).toEqual([3500]);
  });
  it('does not retry a daily quota that is used up, and says so', async () => {
    const s = setup([raw(429, perDay), raw(200, ok)]);
    await expect(s.provider.complete(req)).rejects.toThrow(/429 \(daily quota used up\)/);
    expect(s.calls()).toBe(1);
  });
  it('gives up at once when asked to wait longer than we are willing to', async () => {
    const s = setup([raw(429, 'Please retry in 120s.'), raw(200, ok)]);
    await expect(s.provider.complete(req)).rejects.toThrow('429');
    expect(s.calls()).toBe(1);
    expect(s.waits).toEqual([]);
  });
  it('keeps enough of the message to see which quota it was', async () => {
    const long = 'x'.repeat(300) + ' QUOTA-NAME-AT-THE-END';
    const s = setup([raw(400, long)]);
    await expect(s.provider.complete(req)).rejects.toThrow('QUOTA-NAME-AT-THE-END');
  });
});

describe('quota errors and backup AIs', () => {
  const ai = (name: string, run: () => Promise<string>): LlmProvider => ({ name, complete: run });
  it('still passes on to the backup when a daily quota is used up', async () => {
    const f = new FallbackProvider(
      [ai('a', async () => { throw new HttpError(429, 'daily', undefined, false); }), ai('b', async () => 'from b')],
      () => undefined,
    );
    expect(await f.complete(req)).toBe('from b');
  });
  it('withRetry leaves non-retryable errors alone', async () => {
    let calls = 0;
    await expect(withRetry(async () => (calls++, Promise.reject(new HttpError(429, 'daily', undefined, false))), { sleep: async () => undefined })).rejects.toThrow('daily');
    expect(calls).toBe(1);
  });
});
