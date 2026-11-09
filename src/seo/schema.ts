export type JsonLd = Record<string, unknown>;

export interface ArticleSchemaInput {
  title: string;
  description: string;
  url: string;
  datePublished: string;
  dateModified?: string;
  authorName: string;
  publisherName: string;
  publisherUrl: string;
  imageUrl?: string;
}

export function articleJsonLd(i: ArticleSchemaInput): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: i.title.slice(0, 110),
    description: i.description,
    mainEntityOfPage: { '@type': 'WebPage', '@id': i.url },
    datePublished: i.datePublished,
    dateModified: i.dateModified ?? i.datePublished,
    author: { '@type': 'Organization', name: i.authorName },
    publisher: { '@type': 'Organization', name: i.publisherName, url: i.publisherUrl },
    ...(i.imageUrl ? { image: [i.imageUrl] } : {}),
  };
}

export interface FaqItem {
  question: string;
  answer: string;
}

/** Reads FAQ pairs from the "Frequently asked questions" section: either "**Q?** A" lines or "### Q" headings. */
export function extractFaq(markdown: string): FaqItem[] {
  const m = /^##\s+(?:frequently asked questions|faq)[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im.exec(markdown);
  if (!m) return [];
  const section = m[1] ?? '';
  const items: FaqItem[] = [];
  for (const b of section.matchAll(/^\*\*(.+?\?)\*\*\s*([\s\S]*?)(?=^\*\*.+?\?\*\*|\n###|$(?![\s\S]))/gm)) {
    const answer = (b[2] ?? '').replace(/\s+/g, ' ').trim();
    if (answer) items.push({ question: (b[1] ?? '').trim(), answer });
  }
  if (items.length === 0) {
    for (const b of section.matchAll(/^###\s+(.+?)\s*\n+([\s\S]*?)(?=^###\s|$(?![\s\S]))/gm)) {
      const answer = (b[2] ?? '').replace(/\s+/g, ' ').trim();
      if (answer) items.push({ question: (b[1] ?? '').trim(), answer });
    }
  }
  return items;
}

export function faqJsonLd(items: FaqItem[]): JsonLd | null {
  if (!items.length) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((q) => ({
      '@type': 'Question',
      name: q.question,
      acceptedAnswer: { '@type': 'Answer', text: q.answer },
    })),
  };
}

export function breadcrumbJsonLd(trail: { name: string; url: string }[]): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.name, item: t.url })),
  };
}

export function organizationJsonLd(o: { name: string; url: string; logoUrl?: string; sameAs?: string[] }): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: o.name,
    url: o.url,
    ...(o.logoUrl ? { logo: o.logoUrl } : {}),
    ...(o.sameAs?.length ? { sameAs: o.sameAs } : {}),
  };
}

export interface LocalBusinessInput {
  name: string;
  url: string;
  telephone?: string;
  street?: string;
  locality?: string;
  postcode?: string;
  country?: string;
  openingHours?: string[];
}

export function localBusinessJsonLd(b: LocalBusinessInput): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: b.name,
    url: b.url,
    ...(b.telephone ? { telephone: b.telephone } : {}),
    ...(b.street || b.locality
      ? {
          address: {
            '@type': 'PostalAddress',
            streetAddress: b.street,
            addressLocality: b.locality,
            postalCode: b.postcode,
            addressCountry: b.country ?? 'GB',
          },
        }
      : {}),
    ...(b.openingHours?.length ? { openingHours: b.openingHours } : {}),
  };
}

/** Safe to drop into a page: "<" is escaped so the JSON cannot close the script tag early. */
export function renderJsonLdScript(data: JsonLd): string {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}
