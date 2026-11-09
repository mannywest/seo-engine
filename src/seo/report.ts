import type { AuditResult, Issue, Severity } from './audit.js';

const ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];

/** Renders an audit as a markdown report, grouped by severity and then by rule so repeats read as one item. */
export function renderAuditReport(result: AuditResult): string {
  const lines: string[] = [
    `# SEO audit: ${result.origin}`,
    '',
    `Score: **${result.score}/100** across ${result.pagesCrawled} pages crawled.`,
    '',
    `Critical ${result.counts.critical} · High ${result.counts.high} · Medium ${result.counts.medium} · Low ${result.counts.low}`,
    '',
  ];
  for (const sev of ORDER) {
    const group = result.issues.filter((i) => i.severity === sev);
    if (!group.length) continue;
    lines.push(`## ${sev[0]!.toUpperCase()}${sev.slice(1)}`, '');
    const byRule = new Map<string, Issue[]>();
    for (const i of group) byRule.set(i.id, [...(byRule.get(i.id) ?? []), i]);
    for (const [id, list] of byRule) {
      const first = list[0]!;
      lines.push(`### ${first.message.split(/[.;]/)[0]} (${id}${list.length > 1 ? `, ${list.length} places` : ''})`);
      lines.push(`**Fix:** ${first.fix}`);
      for (const i of list.slice(0, 8)) if (i.url) lines.push(`- ${i.url}${list.length > 1 ? `: ${i.message}` : ''}`);
      if (list.length > 8) lines.push(`- ...and ${list.length - 8} more`);
      lines.push('');
    }
  }
  if (result.issues.length === 0) lines.push('No issues found.', '');
  return lines.join('\n');
}
