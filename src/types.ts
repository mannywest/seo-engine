import type { PlanId } from './plans.js';

export interface ClientProfile {
  id: string;
  /** Which plan the client is on. Defaults to local. */
  plan?: PlanId;
  /** Hard stop on estimated AI tokens per calendar month. Omit for no cap. */
  llmTokenCapPerMonth?: number;
  name: string;
  siteUrl: string;
  description: string;
  audience: string;
  tone: string;
  services: string[];
  keywords: string[];
  internalLinks: { label: string; url: string }[];
  /** Phrases that must never appear in an article (e.g. "guaranteed"). */
  bannedClaims: string[];
  /** Where finished articles are delivered. Omit to keep them as local files only. See src/connectors. */
  connector?: unknown;
  minInternalLinks: number;
  wordRange: { min: number; max: number };
  publish: {
    /** "review": drafts wait for approval. "auto": publish if the quality check passes. */
    mode: 'review' | 'auto';
    cadencePerWeek: number;
    contentDir: string;
    /** URL path where articles live on the site. Defaults to /blog. */
    blogPath?: string;
  };
}

export interface Topic {
  title: string;
  slug: string;
  keyword: string;
  intent: string;
  outline: string[];
}

export interface Source {
  title: string;
  url: string;
  snippet: string;
  /** The whole page text. Used only by the checks (never sent to the AI) so a figure further down the page is not flagged as invented. */
  fullText?: string;
}

export interface Draft {
  topic: Topic;
  title: string;
  description: string;
  body: string;
  tags: string[];
  sources: Source[];
}

export interface QualityReport {
  passed: boolean;
  score: number;
  /** Blocking problems. A draft passes only with none. */
  issues: string[];
  /** Advice for the reviewer; never blocks publishing. */
  warnings: string[];
  /** Confirmed business facts the article relied on. Only present when the answer guard ran. */
  factsUsed?: { label: string; value: string; verifiedAt: string }[];
}
