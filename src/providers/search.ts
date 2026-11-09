import type { Source } from '../types.js';

export interface SearchProvider {
  readonly name: string;
  search(query: string, limit: number): Promise<Source[]>;
}

/** Free provider for tests. Sources are clearly marked and never look real. */
export class MockSearch implements SearchProvider {
  readonly name = 'mock';
  async search(query: string, limit: number): Promise<Source[]> {
    return Array.from({ length: limit }, (_, i) => ({
      title: `[MOCK SOURCE ${i + 1}] ${query}`,
      url: `https://example.com/mock-source-${i + 1}`,
      snippet: `Mock snippet ${i + 1} about ${query}. Contains no real facts.`,
    }));
  }
}

/** Placeholder until a search API is chosen and its spend approved. */
export class NotConfiguredSearch implements SearchProvider {
  readonly name = 'not-configured';
  async search(): Promise<Source[]> {
    throw new Error(
      'No live search provider is configured yet. Choose one (and approve its cost) before using --live.',
    );
  }
}
