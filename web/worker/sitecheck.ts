/**
 * The free site check, pure parts only (no network): is this a public website address, what is the page built with,
 * and what does its home page get right or wrong in plain English. The network side lives in publicApi.ts.
 *
 * Everything here works on text it was handed, never runs a page's code, and returns short plain values.
 */

export type Level = 'good' | 'fix' | 'info';

export interface Finding {
  id: string;
  level: Level;
  title: string;
  /** One or two plain sentences: what we saw and why it matters. */
  detail: string;
}

export type Platform = 'wordpress' | 'shopify' | 'webflow' | 'wix' | 'squarespace' | 'astro' | 'nextjs' | 'hugo' | 'jekyll' | 'gatsby' | 'unknown';

/** How ready we are to connect to this kind of site. Said honestly: only "now" can be used today. */
export type Availability = 'now' | 'soon' | 'later' | 'ask';

// ---- addresses ----------------------------------------------------------------------------------

const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.intranet', '.test', '.invalid', '.example', '.arpa', '.onion'];

/**
 * True for a normal public host name like `www.acme-plumbing.co.uk`. Refuses IP addresses (any spelling the URL parser
 * normalises to one), single-word names like `localhost`, and private or reserved suffixes. The Worker runs on Cloudflare's
 * edge and cannot reach private networks anyway; this is a second lock on the same door.
 */
export function isPublicHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h || h.length > 253) return false;
  if (h.includes(':') || h.startsWith('[')) return false; // IPv6
  if (/^[0-9.]+$/.test(h)) return false; // IPv4 in any form the parser normalises
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) return false; // needs a dot; letters, digits, hyphens only (punycode for accents)
  if (h.split('.').some((label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return false;
  if (h === 'localhost' || BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return false;
  return true;
}

/**
 * Turns what a person typed ("acme-plumbing.co.uk", "https://www.acme.com/about") into a clean public web address,
 * or undefined when it is not one. Only http and https, no logins in the address, no odd ports.
 */
export function parsePublicUrl(input: unknown): URL | undefined {
  if (typeof input !== 'string') return undefined;
  let s = input.trim();
  if (!s || s.length > 300 || /[\s<>"'`\\]/.test(s)) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  if (u.username || u.password) return undefined;
  if (u.port && u.port !== '80' && u.port !== '443') return undefined;
  if (!isPublicHostname(u.hostname)) return undefined;
  u.hash = '';
  return u;
}

/** "www.Acme.com" -> "acme.com": the short name used to tell sign-ups for the same site apart. */
export function bareHost(u: URL): string {
  return u.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

// ---- what is it built with ------------------------------------------------------------------------

/** Guesses the platform from tell-tale fingerprints in the page. A guess, said as a guess. */
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

export const PLATFORM_NAMES: Record<Platform, string> = {
  wordpress: 'WordPress',
  shopify: 'Shopify',
  webflow: 'Webflow',
  wix: 'Wix',
  squarespace: 'Squarespace',
  astro: 'Astro',
  nextjs: 'Next.js',
  hugo: 'Hugo',
  jekyll: 'Jekyll',
  gatsby: 'Gatsby',
  unknown: 'something we could not identify',
};

/** What we can honestly offer for each kind of site today. Copy and download always work, whatever the site is. */
export function platformAdvice(p: Platform): { availability: Availability; text: string } {
  switch (p) {
    case 'astro':
    case 'nextjs':
    case 'hugo':
    case 'jekyll':
    case 'gatsby':
      return {
        availability: 'now',
        text: 'This looks like a site built from code files. If it lives on GitHub, we can connect in one tap and publish each article you approve.',
      };
    case 'wordpress':
      return {
        availability: 'soon',
        text: 'One-tap connecting for WordPress is next on our list. Join the waiting list and we will tell you when it is ready. Until then you can copy or download any approved article.',
      };
    case 'shopify':
    case 'wix':
      return {
        availability: 'later',
        text: `One-tap connecting for ${PLATFORM_NAMES[p]} is planned but not built yet. You can copy or download any approved article and paste it in. Join the waiting list to hear when it is ready.`,
      };
    case 'squarespace':
      return {
        availability: 'later',
        text: 'Squarespace does not let outside tools post to its blogs, so you would copy or download each approved article and paste it in.',
      };
    default:
      return {
        availability: 'ask',
        text: 'We could not tell what this site is built on. Tell us when you sign up and we will check. You can always copy or download any approved article.',
      };
  }
}

// ---- reading the page --------------------------------------------------------------------------

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
const squash = (s: string) => decode(s).replace(/\s+/g, ' ').trim();
const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`[\\s"']${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : undefined;
}

function metaContent(html: string, key: string, by: 'name' | 'property' = 'name'): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (attr(tag, by)?.toLowerCase() === key) return squash(attr(tag, 'content') ?? '');
  }
  return undefined;
}

export interface PageFacts {
  platform: Platform;
  title: string;
  words: number;
}

export interface Analysis {
  facts: PageFacts;
  findings: Finding[];
}

/** True when robots.txt tells every crawler to stay out of the whole site. Reads only the `User-agent: *` group. */
export function robotsBlocksAll(robots: string): boolean {
  let inStar = false;
  let sawRule = false;
  let blocksAll = false;
  let allowsRoot = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === 'user-agent') {
      if (sawRule) inStar = false; // a new group starts after rules
      sawRule = false;
      if (value === '*') inStar = true;
      continue;
    }
    sawRule = true;
    if (!inStar) continue;
    if (field === 'disallow' && value === '/') blocksAll = true;
    if (field === 'allow' && value === '/') allowsRoot = true;
  }
  return blocksAll && !allowsRoot;
}

/**
 * What the home page gets right and wrong, in plain English. `robots` is the site's robots.txt when we could read it.
 * Findings are about the page we saw; they promise nothing about rankings.
 */
export function analysePage(html: string, finalUrl: URL, robots?: string): Analysis {
  const platform = detectPlatform(html);
  const findings: Finding[] = [];
  const add = (id: string, level: Level, title: string, detail: string) => findings.push({ id, level, title, detail });

  const title = squash(/<title[^>]*>([\s\S]{0,400}?)<\/title>/i.exec(html)?.[1] ?? '');
  const description = metaContent(html, 'description') ?? '';
  const h1s = html.match(/<h1\b[^>]*>/gi)?.length ?? 0;
  const htmlTag = /<html\b[^>]*>/i.exec(html)?.[0] ?? '';
  const robotsMeta = (metaContent(html, 'robots') ?? '').toLowerCase();

  // Is it open to search engines at all? The biggest problems first.
  if (/\bnoindex\b/.test(robotsMeta)) add('noindex', 'fix', 'Search engines are told to ignore this page', 'The page carries a "noindex" instruction, which keeps it out of Google. That is only right for a page you want hidden.');
  if (robots !== undefined && robotsBlocksAll(robots)) add('robots', 'fix', 'Your robots.txt shuts every crawler out', 'The file that tells search engines where they may go says "stay out" for the whole site. Tools that read your site, including ours, are shut out too.');

  if (finalUrl.protocol === 'https:') add('https', 'good', 'The site uses a secure connection', 'The address starts with https, which visitors and search engines expect.');
  else add('https', 'fix', 'The site is not on a secure connection', 'The address starts with http, not https. Browsers warn visitors about this.');

  if (!title) add('title', 'fix', 'The home page has no title', 'The title is the headline people see in search results. Without one, Google invents it.');
  else if (title.length < 15 || title.length > 65) add('title', 'info', 'The title length could be better', `The title "${clip(title, 80)}" is ${title.length} characters. Around 15 to 65 shows in full in search results.`);
  else add('title', 'good', 'The home page has a good title', `"${clip(title, 80)}" is a sensible length for search results.`);

  if (!description) add('description', 'fix', 'The home page has no description', 'The short summary under the title in search results is missing, so Google picks a random snippet.');
  else if (description.length < 50 || description.length > 170) add('description', 'info', 'The description length could be better', `It is ${description.length} characters. Around 50 to 170 shows in full.`);
  else add('description', 'good', 'The home page has a good description', 'The summary shown in search results is present and a sensible length.');

  if (h1s === 1) add('h1', 'good', 'One clear main heading', 'The page has a single main heading, which helps people and search engines see what it is about.');
  else if (h1s === 0) add('h1', 'fix', 'No main heading on the page', 'The page has no main (H1) heading, so its topic is less clear.');
  else add('h1', 'info', `${h1s} main headings on one page`, 'One main heading per page is the usual advice. Several can blur what the page is about.');

  if (/<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(html)) add('mobile', 'good', 'Set up for phones', 'The page tells phones how to fit it to the screen.');
  else add('mobile', 'fix', 'Not set up for phones', 'The page has no mobile "viewport" setting, so it may look tiny on a phone.');

  if (!/\blang\s*=/.test(htmlTag)) add('lang', 'info', 'The page does not say what language it is in', 'A language setting on the page helps search engines and screen readers.');

  const images = html.match(/<img\b[^>]*>/gi) ?? [];
  const noAlt = images.filter((tag) => attr(tag, 'alt') === undefined).length;
  if (images.length && noAlt) add('alt', 'fix', `${noAlt} of ${images.length} images have no description`, 'Image descriptions help people using screen readers and help search engines understand pictures.');
  else if (images.length) add('alt', 'good', 'Images have descriptions', 'Every image on the page carries a description.');

  const text = squash(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  );
  const words = text ? text.split(' ').length : 0;
  if (words < 150) add('words', 'info', 'Very little text on the home page', `We counted about ${words} words. Pages with more real content give search engines more to work with.`);

  // Is there somewhere for articles to live? This is what our service adds to.
  let hasBlog = false;
  for (const tag of html.match(/<a\b[^>]*>/gi) ?? []) {
    const href = attr(tag, 'href');
    if (!href) continue;
    let target: URL;
    try {
      target = new URL(href, finalUrl);
    } catch {
      continue;
    }
    if (bareHost(target) !== bareHost(finalUrl)) continue;
    if (/^\/(blog|news|insights|articles|journal|resources|guides)(\/|$)/i.test(target.pathname)) {
      hasBlog = true;
      break;
    }
  }
  if (hasBlog) add('blog', 'good', 'There is a place for articles', 'We found a link to a blog or news section, which is where new articles would go.');
  else add('blog', 'info', 'We did not find a blog or news section', 'Regular helpful articles are how most small sites get found. There is no obvious place for them yet.');

  return { facts: { platform, title: clip(title, 120), words }, findings };
}
