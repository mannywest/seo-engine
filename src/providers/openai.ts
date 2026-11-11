import { HttpError, parseRetryAfter, withRetry, type RetryOptions } from '../retry.js';
import type { LlmProvider, LlmRequest } from './llm.js';

/** The most room we will ask for when a reply keeps getting cut off. */
const MAX_BUDGET = 16_000;

/**
 * Works with any service that speaks the common "OpenAI chat" format. Several offer free tiers
 * (limits and terms change, so check them): Google Gemini, Groq, OpenRouter's free models.
 * This is how a scheduled run in the cloud can write articles without paying per article.
 */
export class OpenAiCompatProvider implements LlmProvider {
  readonly name = 'openai-compatible';
  constructor(
    private apiKey: string,
    private model: string,
    private baseUrl: string,
    private fetchFn: typeof fetch = fetch,
    private retry: RetryOptions = {},
  ) {}

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
    const res = await withRetry(async () => {
      const r = await this.fetchFn(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
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
      });
      if (!r.ok) {
        throw new HttpError(
          r.status,
          `LLM service returned ${r.status}: ${(await r.text()).slice(0, 200)}`,
          parseRetryAfter(r.headers?.get?.('retry-after')),
        );
      }
      return r;
    }, this.retry);
    const json = (await res.json()) as { choices?: { message?: { content?: string | null }; finish_reason?: string }[] };
    const choice = json.choices?.[0];
    return { content: choice?.message?.content ?? '', finish: choice?.finish_reason };
  }
}
