import type { SearchProvider } from '../providers/search.js';
import type { Source, Topic } from '../types.js';

/** Gathers sources for a topic. De-duplicates by URL and caps the count to control cost. */
export async function gatherSources(
  topic: Topic,
  search: SearchProvider,
  maxSources = 6,
): Promise<Source[]> {
  const queries = [topic.keyword, topic.title];
  const byUrl = new Map<string, Source>();
  for (const q of queries) {
    for (const s of await search.search(q, maxSources)) {
      if (!byUrl.has(s.url)) byUrl.set(s.url, s);
    }
  }
  return [...byUrl.values()].slice(0, maxSources);
}
