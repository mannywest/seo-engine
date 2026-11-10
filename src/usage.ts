import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LlmProvider, LlmRequest } from './providers/llm.js';

export interface UsageEntry {
  at: string;
  task: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  /** True when counts are estimated from text length (about 4 characters per token). */
  estimated: boolean;
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export class CapReachedError extends Error {}

/** Per-client record of AI usage. Stored as tokens, not money: we do not guess prices. */
export class UsageLog {
  constructor(
    public entries: UsageEntry[],
    private path: string,
  ) {}

  static async load(clientId: string, dataDir = 'data'): Promise<UsageLog> {
    const path = join(dataDir, clientId, 'usage.json');
    try {
      return new UsageLog(JSON.parse(await readFile(path, 'utf8')) as UsageEntry[], path);
    } catch {
      return new UsageLog([], path);
    }
  }

  add(e: UsageEntry) {
    this.entries.push(e);
  }

  /** Entries for a calendar month, month = "YYYY-MM" (UTC). */
  forMonth(month: string): UsageEntry[] {
    return this.entries.filter((e) => e.at.startsWith(month));
  }

  totalTokens(month: string): number {
    return this.forMonth(month).reduce((n, e) => n + e.inputTokens + e.outputTokens, 0);
  }

  async save() {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.entries, null, 2) + '\n', 'utf8');
  }
}

/** Wraps any provider: records every call and refuses new ones once the monthly token cap is reached. */
export class MeteredProvider implements LlmProvider {
  constructor(
    private inner: LlmProvider,
    private log: UsageLog,
    private opts: { monthlyTokenCap?: number; now?: () => Date } = {},
  ) {}

  get name(): string {
    return this.inner.name;
  }

  async complete(req: LlmRequest): Promise<string> {
    const now = (this.opts.now ?? (() => new Date()))();
    const month = now.toISOString().slice(0, 7);
    const cap = this.opts.monthlyTokenCap;
    if (cap !== undefined && this.log.totalTokens(month) >= cap) {
      throw new CapReachedError(`Monthly AI usage cap (${cap} tokens) reached; stopping to protect cost.`);
    }
    const out = await this.inner.complete(req);
    this.log.add({
      at: now.toISOString(),
      task: req.task,
      provider: this.inner.name,
      inputTokens: estimateTokens(req.system + req.prompt),
      outputTokens: estimateTokens(out),
      estimated: true,
    });
    return out;
  }
}
