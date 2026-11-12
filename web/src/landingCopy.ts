/**
 * Everything the public front page SAYS, and the small pieces of logic that turn a site check into sentences.
 * Kept apart from the screen so the words can be read in one place, tested, and changed without touching layout.
 *
 * Rules the tests enforce: no promise about rankings, no invented numbers, customers or reviews, and nothing claimed
 * that the service cannot do today.
 */

/** The product's working name. A placeholder: change it here and in index.html. */
export const BRAND = 'Lodestar';

/** Plerosis's own first article, written by this service and approved by a person before it went live. */
export const PROOF = {
  title: 'Finding Quick AI Automation Wins for Small Businesses',
  href: 'https://plerosis.com/insights/how-small-businesses-can-identify-ai-automation-wins',
};

export const HERO = {
  headline: 'Get found by more customers. We write, you approve.',
  lead: 'We write articles for your website. Nothing goes live until you say so.',
  checkHint: 'Type your website address and we will tell you what we see, in plain English. It is free and does not ask for a card.',
  button: 'Get my free site check',
  working: 'Looking at your site…',
};

/** The marker every placeholder price carries, so one search finds each of them before the page goes public. */
export const PRICE_PLACEHOLDER = '[YOUR PRICE]';

/**
 * What the service really does today and what is next. Anything not built is not listed as available: the rest of the
 * service catalogue stays off this page until it works.
 */
export const SERVICES: {
  today: { title: string; text: string }[];
  next: { title: string; text: string }[];
} = {
  today: [
    { title: 'Articles for your website', text: 'Written from your own site and notes. You read, edit and approve every one.' },
    { title: 'A free website check', text: 'Type your address and we tell you what we see on your home page, in plain English.' },
    { title: 'Publishing', text: 'One tap for sites built from code files on GitHub. For any other site, copy or download each approved article.' },
  ],
  next: [{ title: 'WordPress', text: 'One-tap connecting to WordPress sites is next on our list.' }],
};

/** Prices are not decided. Each paid line carries the placeholder, never a made-up number. */
export const PRICES: { name: string; text: string; price: string }[] = [
  { name: 'Free website check', text: 'Type your address and read the result. No card and no sign-up.', price: 'Free' },
  { name: 'Articles for your website, approved by you', text: 'Written for your site. You read, edit and approve every one.', price: PRICE_PLACEHOLDER },
];

export const PRICES_NOTE = 'Prices are not set yet. You will not be charged without agreeing to a price first.';

/** A real sequence, so these are numbered. */
export const STEPS = [
  { title: 'Tell us your website address', text: 'That is all we ask for to begin.' },
  { title: 'We write, you approve', text: 'Each article waits in your inbox. Read it, change anything you like, then approve or reject it.' },
  { title: 'It goes on your site', text: 'Only approved articles are published, and only to the site you connected.' },
];

export const PROMISES = [
  { title: 'You approve every article', text: 'Nothing is published until you tap approve. You can edit first, and your edits are kept.' },
  { title: 'No promises about Google', text: 'Nobody can honestly promise a ranking, and we do not. Each article is checked against basics like titles, headings and links, and the results depend on your market and take time.' },
  { title: 'Written from your own material', text: 'Articles draw on your website and any notes you give us. When an article states something your material does not back up, our checks flag it for you.' },
  { title: 'Plain about what is not built yet', text: 'The list of sites we can connect to is below, with what works today and what does not.' },
];

export type Availability = 'now' | 'soon' | 'later' | 'ask';

export const AVAILABILITY_LABEL: Record<Availability, string> = {
  now: 'Works today',
  soon: 'Coming next',
  later: 'Planned',
  ask: 'We will check',
};

/** What we can really do for each kind of site. Copy and download works for every one of them. */
export const CONNECTORS: { name: string; availability: Availability; text: string }[] = [
  { name: 'Sites built from code files on GitHub', availability: 'now', text: 'Connect in one tap. We publish each article you approve.' },
  { name: 'WordPress', availability: 'soon', text: 'One-tap connecting is next on our list.' },
  { name: 'Shopify and Wix', availability: 'later', text: 'Planned. Each needs a separate approval from the platform.' },
  { name: 'Squarespace', availability: 'later', text: 'It does not let outside tools post to its blogs, so you copy each approved article across.' },
  { name: 'Anything else', availability: 'ask', text: 'Copy or download every approved article and paste it in yourself.' },
];

export const FAQ = [
  {
    q: 'Does anything go live without me?',
    a: 'No. Every article waits in your inbox. It reaches your website only after you approve it.',
  },
  {
    q: 'Is AI writing the articles?',
    a: 'Yes. AI drafts them and you decide what is published. You can edit any article before approving it.',
  },
  {
    q: 'Will this get me to the top of Google?',
    a: 'We cannot promise that and nobody honestly can. We write useful articles for your business and check the basics. How they perform depends on your market and takes time.',
  },
  {
    q: 'What do you need from my site?',
    a: 'Just the address to start. To publish for you we connect to your site. Today that is one tap for sites built from code files on GitHub, and WordPress is next. For anything else you can copy or download each approved article.',
  },
  {
    q: 'How much does it cost?',
    a: 'We have not set prices yet. Joining the waiting list is free and does not ask for a card. You will not be charged without agreeing to a price first.',
  },
  {
    q: 'What happens after I join the waiting list?',
    a: 'We review each request ourselves. When yours is ready we email you to sign in and connect your site. Until then nothing is written or published for you.',
  },
];

export const CONSENT_TEXT = 'I am happy for you to email me about my place on the waiting list.';

export const PRIVACY = [
  'When you join the waiting list we keep your email address, your website address and the time you ticked the box above.',
  'We use them only to contact you about your sign-up. We do not sell them.',
  'To limit misuse we also keep a scrambled version of your network address for about a day. It cannot be turned back into your address.',
  'The free site check reads your public home page. It does not keep what it reads.',
  'To ask us to delete your details, reply to any email we send you.',
];

// ---- turning a site check into sentences ----------------------------------------------------------

export interface FindingView {
  id: string;
  level: 'good' | 'fix' | 'info';
  title: string;
  detail: string;
}

export interface Summary {
  good: number;
  fix: number;
  info: number;
}

/** "3 things look fine, 2 are worth fixing and 1 is worth a look." Leaves out any part that is zero. */
export function summaryLine(s: Summary): string {
  const parts: string[] = [];
  if (s.good) parts.push(`${s.good} ${s.good === 1 ? 'thing looks' : 'things look'} fine`);
  if (s.fix) parts.push(`${s.fix} ${s.fix === 1 ? 'is' : 'are'} worth fixing`);
  if (s.info) parts.push(`${s.info} ${s.info === 1 ? 'is' : 'are'} worth a look`);
  if (!parts.length) return 'We could not find much to say about this page.';
  const last = parts.pop()!;
  return `${parts.length ? `${parts.join(', ')} and ` : ''}${last}.`;
}

/** Problems first, then things worth a look, then what is fine. */
export function groupFindings(findings: FindingView[]): { fix: FindingView[]; info: FindingView[]; good: FindingView[] } {
  return { fix: findings.filter((f) => f.level === 'fix'), info: findings.filter((f) => f.level === 'info'), good: findings.filter((f) => f.level === 'good') };
}

/** The first line of a report: what the site seems to be built with, said as a guess. */
export function builtWithLine(site: string, platform: string, platformName: string): string {
  return platform === 'unknown' ? `We could not tell what ${site} is built with.` : `${site} looks like it is built with ${platformName}.`;
}

/**
 * Everything the page ASSERTS, in one string, for tests that check what we never say. FAQ questions are left out on
 * purpose: they are the visitor's own words ("Will this get me to the top of Google?"), and the answer is what we claim.
 */
export function allCopy(): string {
  return JSON.stringify([HERO, STEPS, SERVICES, PRICES, PRICES_NOTE, PROMISES, CONNECTORS, FAQ.map((f) => f.a), CONSENT_TEXT, PRIVACY, AVAILABILITY_LABEL, PROOF.title]);
}
