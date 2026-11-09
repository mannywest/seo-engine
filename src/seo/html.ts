import * as cheerio from 'cheerio';

export interface PageLink {
  href: string;
  text: string;
  internal: boolean;
  nofollow: boolean;
}

export interface PageData {
  url: string;
  status: number;
  redirectChain: string[];
  isHtml: boolean;
  title: string;
  description: string;
  canonical: string;
  robotsMeta: string;
  lang: string;
  viewport: boolean;
  h1: string[];
  headings: { level: number; text: string }[];
  text: string;
  wordCount: number;
  firstParagraph: string;
  images: { src: string; alt: string | null }[];
  links: PageLink[];
  jsonLdTypes: string[];
  og: Record<string, string>;
  hasFaq: boolean;
}

export function normaliseUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return null;
  }
}

function collectTypes(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) return node.forEach((n) => collectTypes(n, out));
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const t = obj['@type'];
    if (typeof t === 'string') out.add(t);
    if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && out.add(x));
    for (const v of Object.values(obj)) collectTypes(v, out);
  }
}

export function emptyPage(url: string, status: number, redirectChain: string[] = []): PageData {
  return {
    url, status, redirectChain, isHtml: false, title: '', description: '', canonical: '', robotsMeta: '',
    lang: '', viewport: false, h1: [], headings: [], text: '', wordCount: 0, firstParagraph: '',
    images: [], links: [], jsonLdTypes: [], og: {}, hasFaq: false,
  };
}

export function parsePage(url: string, status: number, html: string, redirectChain: string[] = []): PageData {
  const $ = cheerio.load(html);
  const origin = new URL(url).origin;

  const jsonLd = new Set<string>();
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      collectTypes(JSON.parse($(el).text()), jsonLd);
    } catch {
      /* invalid JSON-LD is reported by the audit as no structured data */
    }
  });

  const og: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, el) => {
    og[$(el).attr('property') ?? ''] = $(el).attr('content') ?? '';
  });

  const headings: { level: number; text: string }[] = [];
  $('h1,h2,h3,h4,h5,h6').each((_, el) => {
    headings.push({ level: Number(el.tagName.slice(1)), text: $(el).text().replace(/\s+/g, ' ').trim() });
  });

  const links: PageLink[] = [];
  $('a[href]').each((_, el) => {
    const href = normaliseUrl($(el).attr('href') ?? '', url);
    if (!href) return;
    links.push({
      href,
      text: $(el).text().replace(/\s+/g, ' ').trim(),
      internal: new URL(href).origin === origin,
      nofollow: /nofollow/i.test($(el).attr('rel') ?? ''),
    });
  });

  const images: { src: string; alt: string | null }[] = [];
  $('img').each((_, el) => {
    images.push({ src: $(el).attr('src') ?? '', alt: $(el).attr('alt') ?? null });
  });

  const root = $('main').first().length ? $('main').first() : $('article').first().length ? $('article').first() : $('body');
  const clone = root.clone();
  clone.find('script,style,noscript,nav,footer,header').remove();
  const text = clone.text().replace(/\s+/g, ' ').trim();
  let firstParagraph = '';
  clone.find('p').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (!firstParagraph && t.split(' ').length >= 5) firstParagraph = t;
  });

  return {
    url,
    status,
    redirectChain,
    isHtml: true,
    title: $('head title').first().text().replace(/\s+/g, ' ').trim(),
    description: ($('meta[name="description"]').attr('content') ?? '').trim(),
    canonical: ($('link[rel="canonical"]').attr('href') ?? '').trim(),
    robotsMeta: ($('meta[name="robots"]').attr('content') ?? '').toLowerCase(),
    lang: ($('html').attr('lang') ?? '').trim(),
    viewport: $('meta[name="viewport"]').length > 0,
    h1: headings.filter((h) => h.level === 1).map((h) => h.text),
    headings,
    text,
    wordCount: text ? text.split(' ').length : 0,
    firstParagraph,
    images,
    links,
    jsonLdTypes: [...jsonLd],
    og,
    hasFaq: jsonLd.has('FAQPage') || headings.some((h) => /faq|frequently asked/i.test(h.text)),
  };
}
