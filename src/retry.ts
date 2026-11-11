/**
 * Retry with backoff for calls to outside services (AI models, PageSpeed).
 * Think of it as redialling a busy phone line: wait a little, try again, wait longer each time,
 * and give up politely if the line stays busy. Only "busy" and "try later" answers are redialled.
 * Wrong keys and bad requests are not, because trying again cannot fix those.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
    /** False when trying again in a few seconds cannot help (for example a daily quota that is used up). */
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface RetryOptions {
  /** Total tries including the first. Default 4 (so up to 3 waits). */
  attempts?: number;
  /** First wait. It doubles each time. Default 2000ms. */
  baseMs?: number;
  /** No single wait is longer than this. Default 30000ms. */
  maxMs?: number;
  /** Replaceable so tests do not really wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Replaceable so tests are predictable. Returns 0 to 1. */
  random?: () => number;
}

/** Reads the HTTP status off an error if it has one (our HttpError and the Anthropic SDK's errors both do). */
export function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
}

/** "Busy or try later" answers: timeout, too many requests, and the 5xx family. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 504);
}

/** A network failure where no answer came back at all (fetch throws a TypeError). */
function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError;
}

export function isRetryable(e: unknown): boolean {
  if (e instanceof HttpError && !e.retryable) return false;
  const s = statusOf(e);
  return s !== undefined ? isRetryableStatus(s) : isNetworkError(e);
}

/** Reads a Retry-After header (seconds, or a date). Returns milliseconds, or undefined. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/** Some services say how long to wait inside the error text ("Please retry in 12.3s" or "retryDelay": "12s"). */
export function parseRetryHint(body: string): number | undefined {
  const m = /retry in\s+([\d.]+)\s*s/i.exec(body) ?? /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(body);
  return m ? Math.round(Number(m[1]) * 1000) : undefined;
}

/** A quota that resets once a day: waiting seconds will not help. */
export function isDailyQuota(body: string): boolean {
  return /PerDay|per day/i.test(body);
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, o.attempts ?? 4);
  const baseMs = o.baseMs ?? 2000;
  const maxMs = o.maxMs ?? 30_000;
  const sleep = o.sleep ?? realSleep;
  const random = o.random ?? Math.random;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !isRetryable(e)) throw e;
      const asked = e instanceof HttpError ? e.retryAfterMs : undefined;
      // If the service asks for a longer wait than we are willing to give, trying again too soon only fails again.
      if (asked !== undefined && asked > maxMs) throw e;
      // Doubling wait with a little randomness (50% to 100%) so many clients do not all retry together.
      const backoff = Math.min(maxMs, baseMs * 2 ** (i - 1)) * (0.5 + random() * 0.5);
      await sleep(Math.min(maxMs, asked ?? backoff));
    }
  }
}
