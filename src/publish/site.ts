import type { ClientProfile } from '../types.js';
import { clusterKeywords, findCannibalisation } from '../seo/cluster.js';
import { buildRobotsTxt, buildRss, buildSitemapXml } from '../seo/files.js';
import { staleArticles } from '../seo/freshness.js';
import { suggestInternalLinks } from '../seo/links.js';
import { articleJsonLd, extractFaq, faqJsonLd, organizationJsonLd } from '../seo/schema.js';
import { buildLlmsTxt } from './llms.js';
import type { ParsedArticle } from './frontmatter.js';

export interface SiteInput {
  slug: string;
  article: ParsedArticle;
  keyword?: string;
}

export interface SiteOutput {
  /** Relative path -> file contents, ready to copy into the site's public folder. */
  files: Record<string, string>;
  /** Strategy notes for a human: overlaps, missing links, stale content. */
  report: string[];
}

/** Builds the SEO files for a site from its articles. Only published articles go in public files. */
export function buildSiteArtifacts(
  profile: ClientProfile,
  items: SiteInput[],
  opts: { allowAiCrawlers?: boolean; blockAll?: boolean; now?: Date } = {},
): SiteOutput {
  const base = profile.siteUrl.replace(/\/$/, '');
  const prefix = (profile.publish.blogPath ?? '/blog').replace(/\/$/, '');
  const urlOf = (slug: string) => `${base}${prefix}/${slug}`;
  const live = items.filter((i) => i.article.status === 'published');
  const files: Record<string, string> = {};

  files['sitemap.xml'] = buildSitemapXml([
    ...profile.internalLinks.map((l) => ({ loc: new URL(l.url, base).toString() })),
    ...live.map((i) => ({ loc: urlOf(i.slug), lastmod: (i.article.updatedDate ?? i.article.pubDate).slice(0, 10) })),
  ]);
  files['robots.txt'] = buildRobotsTxt({
    sitemapUrl: `${base}/sitemap.xml`,
    allowAiCrawlers: opts.allowAiCrawlers ?? true,
    blockAll: opts.blockAll,
  });
  files['llms.txt'] = buildLlmsTxt(
    profile,
    live.map((i) => ({ title: i.article.title, url: urlOf(i.slug), description: i.article.description })),
  );
  files['rss.xml'] = buildRss({
    title: `${profile.name} articles`,
    link: `${base}${prefix}`,
    description: profile.description,
    items: live.map((i) => ({ title: i.article.title, link: urlOf(i.slug), description: i.article.description, pubDate: i.article.pubDate })),
  });

  for (const i of live) {
    const graph = [
      articleJsonLd({
        title: i.article.title,
        description: i.article.description,
        url: urlOf(i.slug),
        datePublished: i.article.pubDate,
        dateModified: i.article.updatedDate,
        authorName: profile.name,
        publisherName: profile.name,
        publisherUrl: base,
      }),
      faqJsonLd(extractFaq(i.article.body)),
      organizationJsonLd({ name: profile.name, url: base }),
    ].filter(Boolean);
    files[`schema/${i.slug}.json`] = JSON.stringify(graph, null, 2);
  }

  const report: string[] = [];
  const refs = items.map((i) => ({ slug: i.slug, title: i.article.title, keyword: i.keyword ?? i.article.title }));
  for (const c of findCannibalisation(refs)) report.push(`Overlap: "${c.a}" and "${c.b}" target similar searches (${c.similarity}). Merge or differentiate.`);
  for (const s of suggestInternalLinks(items.map((i) => ({ slug: i.slug, url: `${prefix}/${i.slug}`, keyword: i.keyword ?? '', body: i.article.body })))) {
    report.push(`Link: in "${s.from}", link "${s.anchor}" to "${s.to}".`);
  }
  for (const s of staleArticles(items.map((i) => ({ slug: i.slug, pubDate: i.article.pubDate, updatedDate: i.article.updatedDate })), opts.now ?? new Date())) {
    report.push(`Stale: "${s.slug}" is ${s.ageDays} days old. Refresh it.`);
  }
  const groups = clusterKeywords(profile.keywords).filter((g) => g.length > 1);
  for (const g of groups) report.push(`Keyword cluster (write one article): ${g.join(' | ')}`);
  return { files, report };
}
