import type { Fact, FactsVault } from './facts.js';
import { sentences } from './seo/text.js';

/**
 * The answer guard. A free, deterministic check that an article only states things about the business that the
 * business has confirmed in its facts vault. It looks for the claims that cost real customers real trouble when
 * wrong: opening hours, prices the business charges, phone numbers and emails, service areas, credentials,
 * guarantees and years in business.
 *
 * It is a pattern check, not a lie detector. It reads sentences written in the business's own voice ("we", "our",
 * the business name), so it will miss a claim phrased some other way. It fails safe: a claim it cannot match to
 * a confirmed fact is blocked, and a person looks at the draft.
 */

export type Claim =
  | { kind: 'times'; text: string; minutes: number[] }
  | { kind: 'always_open'; text: string }
  | { kind: 'price'; text: string; amounts: number[] }
  | { kind: 'email'; text: string }
  | { kind: 'phone'; text: string; digits: string }
  | { kind: 'area'; text: string; places: string[] }
  | { kind: 'phrase'; text: string; label: string; numberKey?: string };

export interface GuardReport {
  /** Blocking problems: a claim the vault does not back. */
  issues: string[];
  /** Advice that never blocks: stale facts, unverified service areas. */
  warnings: string[];
  /** Vault facts the article relied on, for the proof pack. */
  factsUsed: Fact[];
}

export interface GuardOptions {
  /** The business name, so sentences like "Acme offers..." are read as the business speaking. */
  businessName?: string;
  now?: Date;
}

const DAYS_AND_MONTHS = new Set(
  'monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december'.split(' '),
);
const SKIP_WORDS = new Set(['a', 'an', 'the', 'in', 'of', 'for', 'and', 'since', 'we', 'our', 'is', 'are', 'fully', 'est']);
/** "We recommend you hire a qualified electrician" is advice, not a credential claim. */
const ADVICE = /\b(?:recommend|suggest|advise|hire|hiring|choose|choosing|look(?:ing)? for|ask (?:for|whether|if)|check (?:that|whether|if)|make sure)\b/i;

const TIME = /\b(\d{1,2})(?::([0-5]\d))?\s?(am|pm)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b/gi;
const HOURS_WORD = /\b(?:open|opens|opening|closed|closes|closing|hours|available|appointments?)\b/i;
const ALWAYS_OPEN = /\b24\s?\/\s?7\b|\b24[- ]hours?\b|\bround[- ]the[- ]clock\b|\bopen (?:daily|every day|seven days a week|7 days a week)\b/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?<![\d£.])(?:\+44|0)\s?\d(?:[\s-]?\d){8,10}(?!\d)/g;
const AREA =
  /\b(?:[Ww]e|[Oo]ur\s+(?:team|engineers|technicians|staff))\s+(?:\w+\s+){0,2}?(?:cover|covers|serve|serves|operate|operates|work|works|travel|travels|visit|visits|are based|are located)\s+(?:(?:in|across|throughout|around|to|within)\s+)?(?:the\s+)?((?:[A-Z][\w'’-]+)(?:(?:,\s*|\s+and\s+|\s+&\s+|\s+)[A-Z][\w'’-]+)*)/g;

const PHRASES: { label: string; re: RegExp }[] = [
  {
    label: 'a credential',
    re: /\b(?:accredited|certified|qualified|licen[sc]ed|insured|public liability|professional indemnity|chartered|award[- ]winning|gas safe(?: registered)?|niceic|trustmark|checkatrade|vetted|dbs[- ]checked)\b/gi,
  },
  {
    label: 'a guarantee or promise',
    re: /\b(?:\d+[- ]?(?:day|month|year)s?[- ]guarantee|guarantee[sd]?|warrant(?:y|ies)|money[- ]back|no[- ]obligation|free (?:quotes?|estimates?|consultations?|surveys?|delivery|call-?outs?)|same[- ]day|next[- ]day|emergency call-?outs?|no call-?out fee|satisfaction)\b/gi,
  },
  { label: 'who the business is', re: /\b(?:family[- ](?:run|owned)|locally[- ]owned|independently[- ]owned)\b/gi },
];
const YEARS_IN_BUSINESS = /\b(\d{1,3})\+?\s+years?(?:['’]s?)?\s+(?:of\s+)?(?:experience|in business|trading)\b/gi;
const SINCE_YEAR = /\b(?:since|established in|est\.?|founded in|trading since)\s+((?:19|20)\d{2})\b/gi;
const FILE_EXTENSIONS = /\.(?:png|jpe?g|gif|svg|webp|avif|ico)$/i;

const AMOUNT = /£\s?(\d[\d,]*(?:\.\d{1,2})?)/g;
const amountsIn = (text: string): number[] =>
  [...text.matchAll(AMOUNT)].map((m) => Number((m[1] ?? '').replace(/,/g, ''))).filter((n) => Number.isFinite(n));

function plainSentences(body: string): string[] {
  const plain = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/[*_`>]/g, '');
  return plain.split(/\n+/).flatMap((line) => sentences(line));
}

const snippet = (s: string) => (s.length > 90 ? `${s.slice(0, 90)}...` : s);

function toMinutes(m: RegExpMatchArray): number | null {
  if (m[3]) {
    const h = Number(m[1]);
    if (h < 1 || h > 12) return null;
    return ((h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0)) * 60 + Number(m[2] ?? 0);
  }
  return Number(m[4]) * 60 + Number(m[5]);
}

export function timesIn(text: string): number[] {
  return [...text.matchAll(TIME)].map(toMinutes).filter((n): n is number => n !== null);
}

export function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.startsWith('44') ? `0${digits.slice(2)}` : digits;
}

export function phonesIn(text: string): string[] {
  return [...text.matchAll(PHONE)].map((m) => normalisePhone(m[0]));
}

/** Finds the claims the business is making about itself. Pure text in, claims out: no vault needed. */
export function findBusinessClaims(body: string, opts: GuardOptions = {}): Claim[] {
  const claims: Claim[] = [];
  const name = opts.businessName?.trim().toLowerCase();
  const isBusinessVoice = (s: string) => /\b(?:we|our|ours)\b/i.test(s) || /\bus\b/.test(s) || (!!name && s.toLowerCase().includes(name));

  // Contact details are checked wherever they appear, even outside a sentence (a link, a signature line).
  for (const m of body.matchAll(EMAIL)) if (!FILE_EXTENSIONS.test(m[0])) claims.push({ kind: 'email', text: m[0].toLowerCase() }); // "logo@2x.png" is a file name, not an email
  for (const m of body.matchAll(PHONE)) claims.push({ kind: 'phone', text: m[0].trim(), digits: normalisePhone(m[0]) });

  for (const s of plainSentences(body)) {
    const voice = isBusinessVoice(s);

    const times = timesIn(s);
    if (times.length && HOURS_WORD.test(s)) claims.push({ kind: 'times', text: snippet(s), minutes: times });
    if (ALWAYS_OPEN.test(s) && (voice || /\bopen\b/i.test(s))) claims.push({ kind: 'always_open', text: snippet(s) });

    if (!voice) continue;

    const amounts = amountsIn(s);
    if (amounts.length) claims.push({ kind: 'price', text: snippet(s), amounts });

    for (const m of s.matchAll(AREA)) {
      const places = (m[1] ?? '')
        .split(/\s*(?:,|\band\b|&)\s*/)
        .map((p) => p.trim())
        .filter((p) => p && !DAYS_AND_MONTHS.has(p.toLowerCase()));
      if (places.length) claims.push({ kind: 'area', text: snippet(s), places });
    }

    if (!ADVICE.test(s)) {
      for (const { label, re } of PHRASES) for (const m of s.matchAll(re)) claims.push({ kind: 'phrase', text: m[0], label });
    }
    for (const m of s.matchAll(YEARS_IN_BUSINESS)) claims.push({ kind: 'phrase', text: m[0], label: 'years in business', numberKey: m[1] });
    for (const m of s.matchAll(SINCE_YEAR)) claims.push({ kind: 'phrase', text: m[0], label: 'when the business started', numberKey: m[1] });
  }
  return claims;
}

/** Facts whose label and value contain the phrase's key words (first five letters of each, so "insured" finds "insurance"). */
function factsBacking(phrase: string, facts: Fact[]): Fact[] {
  const keys = (phrase.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !SKIP_WORDS.has(w)).map((w) => (w.length > 5 ? w.slice(0, 5) : w));
  if (!keys.length) return [];
  return facts.filter((f) => {
    const text = `${f.label} ${f.value}`.toLowerCase();
    return keys.every((k) => text.includes(k));
  });
}

const hasNumber = (f: Fact, n: string) => new RegExp(`(?<!\\d)${n}(?!\\d)`).test(`${f.label} ${f.value}`);

/** Compares claims with the vault. A claim the vault does not back is an issue; see GuardReport. */
export function checkClaims(claims: Claim[], vault: FactsVault): Pick<GuardReport, 'issues' | 'warnings'> & { used: Set<string> } {
  const issues = new Set<string>();
  const warnings = new Set<string>();
  const used = new Set<string>();
  const hoursFacts = vault.ofKind('hours');
  const areaFacts = vault.ofKind('area');
  const vaultMinutes = new Set(hoursFacts.flatMap((f) => timesIn(f.value)));
  const vaultEmails = new Map(vault.facts.flatMap((f) => [...f.value.matchAll(EMAIL)].map((m) => [m[0].toLowerCase(), f] as const)));
  const vaultPhones = new Map(vault.facts.flatMap((f) => phonesIn(f.value).map((p) => [p, f] as const)));

  for (const c of claims) {
    switch (c.kind) {
      case 'times': {
        if (!hoursFacts.length) {
          issues.add(`States opening times ("${c.text}") but no opening hours are confirmed in the business facts.`);
          break;
        }
        hoursFacts.forEach((f) => used.add(f.id));
        const wrong = c.minutes.filter((m) => !vaultMinutes.has(m));
        if (wrong.length) issues.add(`Opening times in "${c.text}" do not match the confirmed opening hours.`);
        break;
      }
      case 'always_open': {
        const backing = factsBacking(/24\s?\/\s?7/.test(c.text) ? '24/7' : c.text.match(/24[- ]hours?|round[- ]the[- ]clock|open (?:daily|every day|seven days a week|7 days a week)/i)?.[0] ?? c.text, vault.facts);
        if (backing.length) backing.forEach((f) => used.add(f.id));
        else issues.add(`Says the business is always open ("${c.text}") but that is not confirmed in the business facts.`);
        break;
      }
      case 'price': {
        const confirmed = vault.facts.map((f) => ({ f, amounts: amountsIn(f.value) }));
        const unbacked = c.amounts.filter((a) => !confirmed.some((x) => x.amounts.includes(a)));
        for (const x of confirmed) if (x.amounts.some((a) => c.amounts.includes(a))) used.add(x.f.id);
        if (unbacked.length) issues.add(`States a price the business charges (£${unbacked.join(', £')}) that is not in the confirmed business facts: "${c.text}"`);
        break;
      }
      case 'email': {
        const f = vaultEmails.get(c.text);
        if (f) used.add(f.id);
        else issues.add(`Contains the email address ${c.text}, which is not in the confirmed business facts.`);
        break;
      }
      case 'phone': {
        const f = vaultPhones.get(c.digits);
        if (f) used.add(f.id);
        else issues.add(`Contains the phone number ${c.text}, which is not in the confirmed business facts.`);
        break;
      }
      case 'area': {
        for (const place of c.places) {
          const f = areaFacts.find((a) => a.value.toLowerCase().includes(place.toLowerCase()));
          if (f) used.add(f.id);
          else if (areaFacts.length) issues.add(`Says the business covers ${place}, which is not in its confirmed service areas.`);
          else warnings.add(`Says the business covers ${place}, but no service areas are confirmed in the business facts.`);
        }
        break;
      }
      case 'phrase': {
        const backing = c.numberKey ? vault.facts.filter((f) => hasNumber(f, c.numberKey as string)) : factsBacking(c.text, vault.facts);
        if (backing.length) backing.forEach((f) => used.add(f.id));
        else issues.add(`Claims ${c.label} ("${c.text}") but that is not in the confirmed business facts.`);
        break;
      }
    }
  }
  return { issues: [...issues], warnings: [...warnings], used };
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, '');

/** Runs the whole guard on one article body. */
export function guardDraft(body: string, vault: FactsVault, opts: GuardOptions = {}): GuardReport {
  const { issues, warnings, used } = checkClaims(findBusinessClaims(body, opts), vault);
  // A fact quoted word for word was relied on even if no claim pattern fired.
  const flat = squash(body);
  for (const f of vault.facts) if (f.value.length >= 4 && flat.includes(squash(f.value))) used.add(f.id);

  const stale = vault.stale(opts.now);
  if (stale.length) {
    warnings.push(`${stale.length} confirmed business fact${stale.length === 1 ? ' is' : 's are'} more than 6 months old and should be re-confirmed: ${stale.map((f) => f.label).join(', ')}.`);
  }
  return { issues, warnings, factsUsed: vault.facts.filter((f) => used.has(f.id)) };
}
