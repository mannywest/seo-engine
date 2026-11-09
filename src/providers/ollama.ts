import type { LlmProvider, LlmRequest } from './llm.js';

/**
 * Free option: a model running on your own computer through Ollama (https://ollama.com).
 * No per-article cost, but it needs a reasonably modern machine and quality depends on the model you pull.
 */
export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  constructor(
    private model = 'llama3.1',
    private baseUrl = 'http://localhost:11434',
  ) {}
  async complete(req: LlmRequest): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: 'json',
        options: { num_predict: req.maxTokens },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama returned ${res.status}. Is it running (ollama serve) and the model pulled?`);
    const json = (await res.json()) as { message?: { content?: string } };
    return json.message?.content ?? '';
  }
}
