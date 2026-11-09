export interface ClientProfile {
  id: string;
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
  minInternalLinks: number;
  wordRange: { min: number; max: number };
  publish: {
    /** "review": drafts wait for approval. "auto": publish if the quality check passes. */
    mode: 'review' | 'auto';
    cadencePerWeek: number;
    contentDir: string;
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
  issues: string[];
}
