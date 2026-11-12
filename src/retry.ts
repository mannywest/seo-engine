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
  /** Called just before each wait, so a run's log shows that it is redialling and why. */
  onRetry?: (info: { attempt: number; attempts: number; waitMs: number; error: unknown }) => void;
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

/**
 * A readable reason for an error. Node's fetch says only "fetch failed" and hides the real reason
 * (no connection, timed out, refused) in .cause, so this digs it out for the log.
 */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const parts = [e.message];
  let cause: unknown = (e as { cause?: unknown }).cause;
  for (let depth = 0; cause && depth < 3; depth++) {
    const c = cause as { code?: unknown; message?: unknown; cause?: unknown };
    const code = typeof c.code === 'string' ? c.code : '';
    const msg = typeof c.message === 'string' ? c.message : '';
    const text = [code, msg].filter(Boolean).join(': ');
    if (text && !parts.includes(text)) parts.push(text);
    cause = c.cause;
  }
  return parts.length > 1 ? `${parts[0]} (cause: ${parts.slice(1).join('; ')})` : parts[0]!;
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
      const waitMs = Math.min(maxMs, asked ?? backoff);
      o.onRetry?.({ attempt: i, attempts, waitMs, error: e });
      await sleep(waitMs);
    }
  }
}
