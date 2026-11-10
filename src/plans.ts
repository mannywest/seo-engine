/** Plans and allowances. Prices are the accepted launch prices (ex VAT, GBP per month). */
export type PlanId = 'local' | 'grow' | 'pro';

export type Feature =
  | 'articles'
  | 'gbp_posts'
  | 'review_replies'
  | 'technical_audit'
  | 'ai_search'
  | 'proof_pack'
  | 'assistant'
  | 'monthly_report'
  | 'change_ledger'
  | 'multi_location'
  | 'content_calendar';

export interface Plan {
  id: PlanId;
  name: string;
  priceGbp: number;
  /** Monthly allowances. Anything not listed here is not metered. */
  allowances: { articles: number; gbpPosts: number; locations: number };
  features: Feature[];
}

const BASE: Feature[] = ['articles', 'gbp_posts', 'review_replies', 'proof_pack', 'assistant', 'monthly_report', 'change_ledger'];

export const PLANS: Record<PlanId, Plan> = {
  local: {
    id: 'local',
    name: 'Local',
    priceGbp: 59,
    allowances: { articles: 4, gbpPosts: 4, locations: 1 },
    features: BASE,
  },
  grow: {
    id: 'grow',
    name: 'Grow',
    priceGbp: 129,
    allowances: { articles: 8, gbpPosts: 8, locations: 1 },
    features: [...BASE, 'technical_audit', 'content_calendar'],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceGbp: 249,
    allowances: { articles: 16, gbpPosts: 16, locations: 3 },
    features: [...BASE, 'technical_audit', 'content_calendar', 'ai_search', 'multi_location'],
  },
};

export const ADD_ONS = { extraLocationGbp: 29, contentPackGbp: 49, doneWithYouLaunchGbp: 149 } as const;

export function getPlan(id: PlanId | undefined): Plan {
  return PLANS[id ?? 'local'];
}

export function hasFeature(id: PlanId | undefined, feature: Feature): boolean {
  return getPlan(id).features.includes(feature);
}

export interface MeterLine {
  label: string;
  used: number;
  allowed: number;
  remaining: number;
}

/** What the client has used this month against what they pay for. Shown in the app and on the receipt. */
export function allowanceMeter(id: PlanId | undefined, used: { articles: number; gbpPosts: number }): MeterLine[] {
  const a = getPlan(id).allowances;
  const line = (label: string, u: number, allowed: number): MeterLine => ({
    label,
    used: u,
    allowed,
    remaining: Math.max(0, allowed - u),
  });
  return [line('Articles', used.articles, a.articles), line('Google posts', used.gbpPosts, a.gbpPosts)];
}

export function articlesRemaining(id: PlanId | undefined, usedThisMonth: number): number {
  return Math.max(0, getPlan(id).allowances.articles - usedThisMonth);
}
