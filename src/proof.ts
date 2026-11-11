import { createHash } from 'node:crypto';
import type { ClientProfile, Draft, QualityReport } from './types.js';

export interface ProofPack {
  slug: string;
  title: string;
  createdAt: string;
  generatedBy: string;
  bodySha256: string;
  sources: { title: string; url: string }[];
  checks: { passed: boolean; score: number; issues: string[]; warnings: string[] };
  bannedClaimsChecked: string[];
  /** Confirmed business facts the article relied on. Absent when the answer guard did not run. */
  factsUsed?: { label: string; value: string; verifiedAt: string }[];
}

/** A record of why an article can be trusted: where facts came from, what was checked, and a fingerprint of the text. */
export function buildProof(draft: Draft, quality: QualityReport, profile: ClientProfile, generatedBy: string, now = new Date()): ProofPack {
  return {
    slug: draft.topic.slug,
    title: draft.title,
    createdAt: now.toISOString(),
    generatedBy,
    bodySha256: createHash('sha256').update(draft.body).digest('hex'),
    sources: draft.sources.map((s) => ({ title: s.title, url: s.url })),
    checks: { passed: quality.passed, score: quality.score, issues: quality.issues, warnings: quality.warnings },
    bannedClaimsChecked: profile.bannedClaims,
    ...(quality.factsUsed ? { factsUsed: quality.factsUsed } : {}),
  };
}

/** What the engine actually read from each source page, so a wrong fact can be traced to the page text or to the AI. */
export function renderSources(draft: Draft): string {
  return [
    `# Source text used for: ${draft.title}`,
    '',
    ...draft.sources.flatMap((s) => [`## ${s.title}`, s.url, '', s.fullText ?? s.snippet, '']),
  ].join('\n');
}

export function renderProof(p: ProofPack): string {
  const lines = [
    `# Proof pack: ${p.title}`,
    '',
    `Created ${p.createdAt} by ${p.generatedBy}. Text fingerprint (SHA-256): ${p.bodySha256}`,
    '',
    `Automatic checks: ${p.checks.passed ? 'passed' : 'FAILED'} (score ${p.checks.score}/100).`,
    ...p.checks.issues.map((i) => `- Problem: ${i}`),
    ...p.checks.warnings.map((w) => `- Note: ${w}`),
    '',
    '## Sources',
    ...(p.sources.length ? p.sources.map((s) => `- ${s.title} (${s.url})`) : ['- None supplied']),
    '',
    `## Claims we never make`,
    ...(p.bannedClaimsChecked.length ? p.bannedClaimsChecked.map((c) => `- "${c}"`) : ['- None configured']),
    ...(p.factsUsed
      ? [
          '',
          '## Business facts relied on',
          ...(p.factsUsed.length ? p.factsUsed.map((f) => `- ${f.label}: ${f.value} (confirmed ${f.verifiedAt})`) : ['- None. The article makes no claims that need confirmed facts.']),
        ]
      : []),
  ];
  return lines.join('\n') + '\n';
}
