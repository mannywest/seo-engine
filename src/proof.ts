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
  };
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
  ];
  return lines.join('\n') + '\n';
}
