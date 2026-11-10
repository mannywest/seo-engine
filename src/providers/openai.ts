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
  ) {}
  async complete(req: LlmRequest): Promise<string> {
    const res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
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
    if (!res.ok) throw new Error(`LLM service returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? '';
  }
}
