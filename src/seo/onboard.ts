import { crawlSite, defaultFetcher, type Fetcher } from './crawl.js';
import { normaliseUrl } from './html.js';
import { extractJson } from '../pipeline/plan.js';
import type { LlmProvider } from '../providers/llm.js';
import type { ClientProfile } from '../types.js';

export type Platform = 'wordpress' | 'shopify' | 'webflow' | 'wix' | 'squarespace' | 'astro' | 'nextjs' | 'hugo' | 'jekyll' | 'gatsby' | 'unknown';

/** Guesses what the site is built with from tell-tale fingerprints in its HTML. */
export function detectPlatform(html: string): Platform {
  const h = html.toLowerCase();
  if (/wp-content|wp-includes|<meta name="generator" content="wordpress/.test(h)) return 'wordpress';
  if (/cdn\.shopify\.com|shopify\.theme/.test(h)) return 'shopify';
  if (/data-wf-site|webflow\.com|<meta name="generator" content="webflow/.test(h)) return 'webflow';
  if (/static\.parastorage\.com|wix\.com|<meta name="generator" content="wix/.test(h)) return 'wix';
  if (/squarespace/.test(h)) return 'squarespace';
  if (/<meta name="generator" content="astro|astro-island|data-astro-cid/.test(h)) return 'astro';
  if (/\/_next\/static|__next_data__/.test(h)) return 'nextjs';
  if (/<meta name="generator" content="hugo/.test(h)) return 'hugo';
  if (/<meta name="generator" content="jekyll/.test(h)) return 'jekyll';
  if (/<meta name="generator" content="gatsby|___gatsby/.test(h)) return 'gatsby';
  return 'unknown';
}

/** Which connector type fits each platform, in plain words. */
export function connectorAdvice(p: Platform): { connector: 'git' | 'wordpress' | 'webhook'; why: string } {
  switch (p) {
    case 'wordpress':
      return { connector: 'wordpress', why: 'WordPress has a built-in way to receive posts. The client makes an Application Password in their profile.' };
    case 'astro':
    case 'nextjs':
    case 'hugo':
    case 'jekyll':
    case 'gatsby':
      return { connector: 'git', why: 'This kind of site is built from files in a GitHub repo, so we open a pull request with the new article.' };
    default:
      return { connector: 'webhook', why: 'No direct plug for this platform yet. The webhook sends articles to Zapier/Make/n8n, which file them in the CMS.' };
  }
}

const idFromUrl = (url: string) => new URL(url).hostname.replace(/^www\./, '').split('.')[0]!.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

function siteName(title: string, og: string | undefined, host: string): string {
  if (og) return og;
  const parts = title.split(/\s[|\-–—:]\s/).map((s) => s.trim()).filter(Boolean);
  // Prefer the part of the title that matches the domain ("Acme Plumbing | Leeds" on acme.com), else the first part.
  const key = host.split('.')[0]!.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const match = parts.find((p) => p.toLowerCase().replace(/[^a-z0-9]/g, '').includes(key));
  return match ?? parts[0] ?? host;
}

export interface OnboardResult {
  profile: ClientProfile;
  platform: Platform;
  advice: ReturnType<typeof connectorAdvice>;
  /** Things a human should look at before the first real run. */
  review: string[];
}

/**
 * Turns a website address into a ready-to-edit client profile. Free: it reads the site's own pages.
 * With an AI provider it also drafts audience, tone, services and target keywords; without one it leaves
 * safe defaults and says what to fill in.
 */
export async function onboardSite(
  url: string,
  opts: { fetcher?: Fetcher; llm?: LlmProvider; id?: string; maxPages?: number } = {},
): Promise<OnboardResult> {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const start = normaliseUrl(url);
  if (!start) throw new Error(`"${url}" is not a valid web address.`);
  const origin = new URL(start).origin;
  const snap = await crawlSite(start, fetcher, { maxPages: opts.maxPages ?? 25 });
  const home = [...snap.pages.values()][0];
  if (!home || !home.isHtml || home.status < 200 || home.status >= 400) {
    throw new Error(`Could not read ${start} (status ${home?.status || 'no response'}). Check the address, and that the site is public.`);
  }
  const homeHtml = (await fetcher(start).catch(() => null))?.body ?? '';

  const platform = detectPlatform(homeHtml);
  const host = new URL(origin).hostname.replace(/^www\./, '');
  const name = siteName(home.title, home.og['og:site_name'], host);

  const seen = new Set<string>(['/']);
  const internalLinks: { label: string; url: string }[] = [];
  for (const l of home.links) {
    if (!l.internal || l.nofollow) continue;
    const path = new URL(l.href, origin).pathname;
    const text = l.text.trim();
    if (seen.has(path) || !text || text.length > 30 || /\.(pdf|jpg|png|zip)$/i.test(path)) continue;
    seen.add(path);
    internalLinks.push({ label: text, url: path });
    if (internalLinks.length >= 8) break;
  }

  const profile: ClientProfile = {
    id: opts.id ?? idFromUrl(origin),
    name,
    siteUrl: origin,
    description: home.description || home.firstParagraph.slice(0, 200),
    audience: `People looking for what ${name} offers.`,
    tone: 'Plain English, honest and practical. No hype and no invented results.',
    services: home.headings.filter((h) => h.level === 2).map((h) => h.text).slice(0, 5),
    keywords: [],
    internalLinks,
    bannedClaims: ['guaranteed', 'revolutionary', 'game-changing', '10x', 'cutting-edge', 'unlock the power'],
    minInternalLinks: Math.min(2, Math.max(0, internalLinks.length)),
    wordRange: { min: 900, max: 1800 },
    publish: { mode: 'review', cadencePerWeek: 1, contentDir: 'src/content/blog' },
  };

  const review: string[] = [];
  if (opts.llm) {
    const sample = [...snap.pages.values()].slice(0, 8).map((p) => `${p.title}\n${p.text.slice(0, 600)}`).join('\n---\n');
    try {
      const raw = await opts.llm.complete({
        task: 'plan',
        maxTokens: 800,
        system: 'You profile a business from its website text. Reply with JSON only: {"audience":string,"tone":string,"services":string[],"keywords":string[]}. Use only what the text supports. 5 target search phrases in keywords.',
        prompt: `Business: ${name}\n${sample}`,
      });
      const j = extractJson(raw) as Partial<Pick<ClientProfile, 'audience' | 'tone' | 'services' | 'keywords'>>;
      if (j.audience) profile.audience = j.audience;
      if (j.tone) profile.tone = j.tone;
      if (j.services?.length) profile.services = j.services.slice(0, 8);
      if (j.keywords?.length) profile.keywords = j.keywords.slice(0, 8);
      review.push('Audience, tone, services and keywords were drafted by AI from the site text. Read them and correct anything wrong.');
    } catch {
      review.push('The AI profile step failed, so audience, tone and keywords are basic defaults. Edit them by hand.');
    }
  } else {
    review.push('No AI was used. Fill in "audience" and "keywords" (the searches you want to be found for) before the first real run.');
  }
  if (!profile.services.length) review.push('No services were found on the homepage. List them in "services".');
  if (!profile.description) review.push('The homepage has no description. Write one in "description".');
  review.push('Publishing is set to "review": nothing goes live without approval.');
  return { profile, platform, advice: connectorAdvice(platform), review };
}
