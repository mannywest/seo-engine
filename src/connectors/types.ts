/** One article ready to leave the engine. */
export interface PublishItem {
  slug: string;
  title: string;
  description: string;
  tags: string[];
  /** Markdown body without front matter. */
  body: string;
  /** Full markdown file including front matter. */
  markdown: string;
}

export interface PublishResult {
  slug: string;
  ok: boolean;
  /** Link to the pull request, WordPress post, file, etc. */
  url?: string;
  note?: string;
}

export interface PublishContext {
  clientId: string;
  clientName: string;
  /** "review": a human must approve before it goes live. "auto": goes live on its own. */
  mode: 'review' | 'auto';
}

/**
 * A connector is the plug that fits one kind of website.
 * The engine writes articles; the connector delivers them. Nothing else in the engine knows what site type it is.
 */
export interface Connector {
  readonly type: string;
  /** Returns a list of problems (empty means ready). Never publishes anything. */
  check(): Promise<string[]>;
  publish(items: PublishItem[], ctx: PublishContext): Promise<PublishResult[]>;
}

export type Fetch = typeof fetch;
export type Env = Record<string, string | undefined>;
