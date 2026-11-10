export type Rating = 'good' | 'needs improvement' | 'poor';

export interface SpeedReport {
  url: string;
  strategy: 'mobile' | 'desktop';
  performanceScore: number | null;
  /** Lab numbers (a simulated test run by Lighthouse). */
  lab: { lcpMs?: number; cls?: number; tbtMs?: number; fcpMs?: number };
  /** Field numbers (real Chrome users over 28 days). Only present for sites with enough traffic. */
  field: { lcpMs?: number; inpMs?: number; cls?: number };
  ratings: { lcp?: Rating; inp?: Rating; cls?: Rating };
  advice: string[];
}

const rate = (v: number | undefined, good: number, poor: number): Rating | undefined =>
  v === undefined ? undefined : v <= good ? 'good' : v <= poor ? 'needs improvement' : 'poor';

interface PsiResponse {
  lighthouseResult?: {
    categories?: { performance?: { score?: number | null } };
    audits?: Record<string, { numericValue?: number; score?: number | null; title?: string; details?: { type?: string; overallSavingsMs?: number } }>;
  };
  loadingExperience?: { metrics?: Record<string, { percentile?: number }> };
}

/** Turns Google's raw PageSpeed Insights answer into the three Core Web Vitals plus plain advice. Pure, so it is testable offline. */
export function summarisePsi(url: string, strategy: 'mobile' | 'desktop', psi: PsiResponse): SpeedReport {
  const audits = psi.lighthouseResult?.audits ?? {};
  const f = psi.loadingExperience?.metrics ?? {};
  const lab = {
    lcpMs: audits['largest-contentful-paint']?.numericValue,
    cls: audits['cumulative-layout-shift']?.numericValue,
    tbtMs: audits['total-blocking-time']?.numericValue,
    fcpMs: audits['first-contentful-paint']?.numericValue,
  };
  const field = {
    lcpMs: f.LARGEST_CONTENTFUL_PAINT_MS?.percentile,
    inpMs: f.INTERACTION_TO_NEXT_PAINT?.percentile,
    cls: f.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile === undefined ? undefined : f.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100,
  };
  // Prefer real-user numbers when Google has them; fall back to the lab test.
  const ratings = {
    lcp: rate(field.lcpMs ?? lab.lcpMs, 2500, 4000),
    inp: rate(field.inpMs, 200, 500),
    cls: rate(field.cls ?? lab.cls, 0.1, 0.25),
  };
  const advice: string[] = [];
  if (ratings.lcp && ratings.lcp !== 'good') advice.push('Main content loads slowly (LCP). Compress and properly size the largest image, and avoid render-blocking scripts.');
  if (ratings.inp && ratings.inp !== 'good') advice.push('The page reacts slowly to clicks (INP). Reduce heavy JavaScript.');
  if (ratings.cls && ratings.cls !== 'good') advice.push('Content jumps around while loading (CLS). Give images and embeds fixed width and height.');
  const opportunities = Object.values(audits)
    .filter((a) => a.details?.type === 'opportunity' && (a.details.overallSavingsMs ?? 0) > 300)
    .sort((a, b) => (b.details?.overallSavingsMs ?? 0) - (a.details?.overallSavingsMs ?? 0))
    .slice(0, 3);
  for (const o of opportunities) advice.push(`Google suggests: ${o.title} (could save about ${Math.round((o.details!.overallSavingsMs ?? 0) / 100) / 10}s).`);
  const score = psi.lighthouseResult?.categories?.performance?.score;
  return { url, strategy, performanceScore: score == null ? null : Math.round(score * 100), lab, field, ratings, advice };
}

/** Free. Works without a key at low volume; set PAGESPEED_API_KEY (also free) for regular use. */
export async function runPageSpeed(
  url: string,
  strategy: 'mobile' | 'desktop' = 'mobile',
  env = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<SpeedReport> {
  const q = new URLSearchParams({ url, strategy, category: 'performance' });
  if (env.PAGESPEED_API_KEY) q.set('key', env.PAGESPEED_API_KEY);
  const res = await fetchFn(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, { signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`PageSpeed Insights returned ${res.status}. If it is 429, set PAGESPEED_API_KEY.`);
  return summarisePsi(url, strategy, (await res.json()) as PsiResponse);
}

export function renderSpeed(r: SpeedReport): string {
  const l = (name: string, v: string, rt?: Rating) => `  ${name}: ${v}${rt ? ` (${rt})` : ''}`;
  return [
    `${r.url} [${r.strategy}] performance score: ${r.performanceScore ?? 'n/a'}/100`,
    l('LCP', (r.field.lcpMs ?? r.lab.lcpMs) !== undefined ? `${Math.round((r.field.lcpMs ?? r.lab.lcpMs)!)}ms` : 'n/a', r.ratings.lcp),
    l('INP', r.field.inpMs !== undefined ? `${r.field.inpMs}ms` : 'n/a (needs real-user data)', r.ratings.inp),
    l('CLS', (r.field.cls ?? r.lab.cls) !== undefined ? String(Math.round((r.field.cls ?? r.lab.cls)! * 1000) / 1000) : 'n/a', r.ratings.cls),
    ...r.advice.map((a) => `  - ${a}`),
  ].join('\n');
}
