import Anthropic from '@anthropic-ai/sdk';

export type LlmTask = 'plan' | 'draft';

export interface LlmRequest {
  task: LlmTask;
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<string>;
}

/** Real provider. Costs money: only used with an API key and an explicit --live flag. */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private client: Anthropic;
  constructor(
    apiKey: string,
    private model = 'claude-sonnet-5-5',
  ) {
    this.client = new Anthropic({ apiKey });
  }
  async complete(req: LlmRequest): Promise<string> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.prompt }],
    });
    const block = res.content.find((b) => b.type === 'text');
    return block && block.type === 'text' ? block.text : '';
  }
}

/** Free, deterministic provider for tests and pipeline checks. Output is clearly marked as mock. */
export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  private n = 0;
  async complete(req: LlmRequest): Promise<string> {
    if (req.task === 'plan') {
      const count = Number(/COUNT=(\d+)/.exec(req.prompt)?.[1] ?? 3);
      const topics = Array.from({ length: count }, (_, i) => ({
        title: `[MOCK] Topic ${i + 1} for planning`,
        keyword: `mock keyword ${i + 1}`,
        intent: 'informational',
        outline: ['What it is', 'How it works', 'Getting started'],
      }));
      return JSON.stringify({ topics });
    }
    this.n += 1;
    const body = [
      '[MOCK DRAFT: placeholder text, not a real article.]',
      '',
      '## What it is',
      'Placeholder answer-first paragraph. See [our services](/what-we-do) for more.',
      '',
      '## How it works',
      'Placeholder paragraph with a second link to [how we work](/how-we-work).',
      '',
      '## Getting started',
      'Placeholder paragraph.',
      '',
      '## Frequently asked questions',
      '**Question one?** Placeholder answer.',
    ].join('\n');
    return JSON.stringify({
      title: `[MOCK] Draft article ${this.n}`,
      description:
        'Placeholder meta description written by the mock provider so the pipeline can be tested end to end.',
      body,
      tags: ['mock'],
    });
  }
}
