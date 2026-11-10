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
  /** What the same connector needs later to undo this delivery. Stored in the change ledger. Absent when it cannot be undone. */
  handle?: Record<string, unknown>;
}

export interface RevertContext {
  mode: 'review' | 'auto';
  clientName: string;
  /** Undo even if the page has been changed by someone since we delivered it. Changed text is still kept aside, never deleted. */
  force?: boolean;
}

export interface RevertResult {
  ok: boolean;
  /** True when the connector deliberately did nothing, because undoing would destroy someone's later changes. */
  refused?: boolean;
  /** True when the undo has been prepared but needs approval before it takes effect (for example a pull request to merge). */
  pending?: boolean;
  note: string;
  url?: string;
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
  /**
   * Undoes one earlier delivery, given the handle that publish returned. Optional: a connector that hands the article to
   * another system (a webhook) cannot know what happened next, so it does not offer this.
   * Safety rule for every implementation: if the page was changed after we delivered it, refuse unless ctx.force is set,
   * and never destroy anything. Move it aside or send it to the platform's trash.
   */
  revert?(handle: Record<string, unknown>, ctx: RevertContext): Promise<RevertResult>;
}

export type Fetch = typeof fetch;
export type Env = Record<string, string | undefined>;
