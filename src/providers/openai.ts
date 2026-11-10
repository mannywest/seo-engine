import { HttpError, parseRetryAfter, withRetry, type RetryOptions } from '../retry.js';
import type { LlmProvider, LlmRequest } from './llm.js';

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
  async complete(req: LlmRequest): Promise<string> {
    // Busy or overloaded answers (429, 5xx) are retried with growing waits; other errors stop straight away.
    const res = await withRetry(async () => {
      const r = await this.fetchFn(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          max_tokens: req.maxTokens,
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
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? '';
  }
}
