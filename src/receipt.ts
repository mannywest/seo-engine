import type { HistoryEntry } from './history.js';
import { allowanceMeter, getPlan, type PlanId } from './plans.js';
import type { UsageEntry } from './usage.js';

/** Plain-English monthly record of the work done for a client. Month = "YYYY-MM" (UTC). */
export function buildReceipt(opts: {
  clientName: string;
  month: string;
  plan?: PlanId;
  history: HistoryEntry[];
  usage?: UsageEntry[];
  gbpPostsPublished?: number;
}): string {
  const mine = opts.history.filter((e) => e.createdAt.startsWith(opts.month));
  const delivered = mine.filter((e) => e.deliveredTo);
  const held = mine.filter((e) => !e.passed);
  const plan = getPlan(opts.plan);
  const meter = allowanceMeter(opts.plan, { articles: delivered.length, gbpPosts: opts.gbpPostsPublished ?? 0 });
  const tokens = (opts.usage ?? []).reduce((n, e) => n + e.inputTokens + e.outputTokens, 0);
  const lines = [
    `# Work receipt: ${opts.clientName}, ${opts.month}`,
    `Plan: ${plan.name} (£${plan.priceGbp}/month ex VAT)`,
    '',
    '## What we did',
    `- Articles written: ${mine.length}`,
    `- Delivered to your site: ${delivered.length}`,
    `- Held back because they failed our checks: ${held.length}`,
    ...delivered.map((e) => `  - ${e.title} (${e.deliveredTo})`),
    ...held.map((e) => `  - Held: ${e.title}`),
    '',
    '## Your allowance this month',
    ...meter.map((m) => `- ${m.label}: ${m.used} of ${m.allowed} used, ${m.remaining} left`),
    '',
    `AI work this month: about ${tokens.toLocaleString('en-GB')} tokens (estimated).`,
    '',
    'We do not promise rankings. This receipt lists work delivered.',
  ];
  return lines.join('\n') + '\n';
}
