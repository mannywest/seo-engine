export interface RobotsGroup {
  agents: string[];
  allow: string[];
  disallow: string[];
}

export interface Robots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export const AI_CRAWLERS = ['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'anthropic-ai', 'PerplexityBot', 'Google-Extended', 'CCBot'];

export function parseRobots(text: string): Robots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'sitemap') {
      sitemaps.push(value);
    } else if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    } else if (current && key === 'disallow') {
      if (value) current.disallow.push(value);
    } else if (current && key === 'allow') {
      current.allow.push(value);
    }
    lastWasAgent = false;
  }
  return { groups, sitemaps };
}

/** True if the given crawler is barred from the whole site. The most specific matching group wins. */
export function blocksWholeSite(robots: Robots, agent: string): boolean {
  const a = agent.toLowerCase();
  const specific = robots.groups.find((g) => g.agents.includes(a));
  const group = specific ?? robots.groups.find((g) => g.agents.includes('*'));
  if (!group) return false;
  const blocked = group.disallow.includes('/');
  const reopened = group.allow.includes('/');
  return blocked && !reopened;
}

/** True if a path is disallowed for the agent (prefix match; longest rule wins, allow beats disallow on ties). */
export function isPathBlocked(robots: Robots, agent: string, path: string): boolean {
  const a = agent.toLowerCase();
  const group = robots.groups.find((g) => g.agents.includes(a)) ?? robots.groups.find((g) => g.agents.includes('*'));
  if (!group) return false;
  const best = (rules: string[]) =>
    rules.filter((r) => r && path.startsWith(r)).reduce((m, r) => Math.max(m, r.length), -1);
  const d = best(group.disallow);
  const al = best(group.allow);
  return d > -1 && d > al;
}
