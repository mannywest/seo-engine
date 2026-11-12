import { describeError, HttpError, isDailyQuota, parseRetryAfter, parseRetryHint, withRetry, type RetryOptions } from '../retry.js';
import type { LlmProvider, LlmRequest } from './llm.js';

/** The most room we will ask for when a reply keeps getting cut off. */
const MAX_BUDGET = 16_000;

/**
 * How long one request to the AI may take before we give up on it. Without a limit, a request that hangs
 * waits about five minutes before Node gives up, and with redials a single stuck call could cost a quarter of an hour.
 * A long article takes a minute or two to write, so this is generous.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 150_000;

/** After this many timed-out requests in a row we stop redialling: the service is not answering. */
const MAX_TIMEOUTS = 2;

/**
 * Works with any service that speaks the common "OpenAI chat" format. Several offer free tiers
 * (limits and terms change, so check them): Google Gemini, Groq, OpenRouter's free models.
 * This is how a scheduled run in the cloud can write articles without paying per article.
 */
export class OpenAiCompatProvider implements LlmProvider {
  readonly name: string;
  constructor(
    private apiKey: string,
    private model: string,
    private baseUrl: string,
    private fetchFn: typeof fetch = fetch,
    private retry: RetryOptions = {},
    private timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
    /** What the logs call this AI (for example gemini or groq), so a backup taking over reads clearly. */
    label = 'openai-compatible',
  ) {
    this.name = label;
  }

  /**
   * If the AI runs out of room before it finishes ("length"), ask again with double the room, up to twice.
   * Models that think before answering spend part of the limit on thinking, so a long article can leave
   * nothing for the answer itself.
   */
  async complete(req: LlmRequest): Promise<string> {
    let budget = req.maxTokens;
    for (let widened = 0; ; widened++) {
      const { content, finish } = await this.once(req, budget);
      if (finish !== 'length') return content;
      const next = Math.min(MAX_BUDGET, budget * 2);
      if (widened < 2 && next > budget) {
        budget = next;
        continue;
      }
      if (!content.trim()) {
        throw new Error(
          `The AI used its whole reply limit (${budget} tokens) without writing an answer. Models that think before answering spend part of the limit on thinking.`,
        );
      }
      return content; // cut off but not empty: the caller checks it and asks again if it cannot be used
    }
  }

  private async once(req: LlmRequest, maxTokens: number): Promise<{ content: string; finish?: string }> {
    // Busy or overloaded answers (429, 5xx) are retried with growing waits; other errors stop straight away.
    let timeouts = 0;
    const res = await withRetry(async () => {
      let r: Response;
      try {
        r = await this.fetchFn(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model: this.model,
            max_tokens: maxTokens,
            messages: [
              { role: 'system', content: req.system },
              { role: 'user', content: req.prompt },
            ],
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        if ((e as { name?: string } | null)?.name === 'TimeoutError') {
          timeouts += 1;
          // A "request timeout" answer, redialled once, then given up so a dead service cannot eat the whole run.
          throw new HttpError(408, `The AI did not answer within ${Math.round(this.timeoutMs / 1000)} seconds`, undefined, timeouts < MAX_TIMEOUTS);
        }
        throw e;
      }
      if (!r.ok) {
        const body = await r.text();
        const daily = r.status === 429 && isDailyQuota(body);
        throw new HttpError(
          r.status,
          `LLM service returned ${r.status}${daily ? ' (daily quota used up)' : ''}: ${body.slice(0, 500)}`,
          parseRetryAfter(r.headers?.get?.('retry-after')) ?? parseRetryHint(body),
          !daily,
        );
      }
      return r;
    }, {
      onRetry: ({ attempt, attempts, waitMs, error }) =>
        console.warn(`AI request failed (${describeError(error).slice(0, 200)}). Try ${attempt} of ${attempts}; waiting ${Math.round(waitMs / 1000)}s.`),
      ...this.retry,
    });
    const json = (await res.json()) as { choices?: { message?: { content?: string | null }; finish_reason?: string }[] };
    const choice = json.choices?.[0];
    return { content: choice?.message?.content ?? '', finish: choice?.finish_reason };
  }
}
