import type { LlmProvider, LlmRequest } from './llm.js';
import { isRetryableStatus, statusOf } from '../retry.js';

/**
 * Tries the main AI first. If it is down or overloaded (after its own retries), or the model has
 * been withdrawn (404), the next AI in the list takes over. Wrong keys (401, 403) and bad requests (400)
 * are NOT passed on: those are set-up mistakes and should be seen, not hidden behind a backup.
 */
export class FallbackProvider implements LlmProvider {
  readonly name: string;
  constructor(
    private providers: LlmProvider[],
    private onFallback: (from: string, to: string, error: unknown) => void = (from, to, e) =>
      console.warn(`AI "${from}" failed (${(e as Error).message.slice(0, 120)}). Trying "${to}".`),
  ) {
    if (providers.length === 0) throw new Error('FallbackProvider needs at least one AI.');
    this.name = providers.map((p) => p.name).join(' -> ');
  }

  async complete(req: LlmRequest): Promise<string> {
    let last: unknown;
    for (let i = 0; i < this.providers.length; i++) {
      const p = this.providers[i]!;
      try {
        return await p.complete(req);
      } catch (e) {
        if (!shouldFallBack(e)) throw e;
        last = e;
        const next = this.providers[i + 1];
        if (next) this.onFallback(p.name, next.name, e);
      }
    }
    throw last;
  }
}

export function shouldFallBack(e: unknown): boolean {
  const s = statusOf(e);
  if (s !== undefined) return isRetryableStatus(s) || s === 404;
  return e instanceof TypeError; // no answer at all
}
