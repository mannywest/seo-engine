import { describe, expect, it } from 'vitest';
import { platformAdvice, type Platform } from '../worker/sitecheck';
import { allCopy, AVAILABILITY_LABEL, builtWithLine, CONNECTORS, FAQ, groupFindings, HERO, PROMISES, PROOF, STEPS, summaryLine, type FindingView } from '../src/landingCopy';
import { arrivingFromLink, wantsDemo } from '../src/route';

describe('what the front page says', () => {
  const copy = allCopy().toLowerCase();

  it('never promises a ranking or a result', () => {
    expect(copy).not.toMatch(/guarantee|#1|number one|top of google|first page of google|rank higher|more traffic|double your|10x|\bseo expert/);
    // the page may say we cannot promise one; it must say so rather than stay silent
    expect(FAQ.some((f) => /cannot promise/i.test(f.a))).toBe(true);
    expect(PROMISES.some((p) => /no promises about google/i.test(p.title))).toBe(true);
  });

  it('invents no customers, numbers, awards or reviews', () => {
    expect(copy).not.toMatch(/\d+\s?%|\b\d{2,}\+? (customers|clients|businesses|sites|users)|trusted by|as seen|award|testimonial|five.star|rated |reviews? from/);
  });

  it('says plainly that approval comes first, and that AI is used', () => {
    expect(HERO.headline).toMatch(/nothing goes live until you say so/i);
    expect(FAQ.find((f) => /ai writing/i.test(f.q))?.a).toMatch(/^Yes/);
  });

  it('does not set a price or claim a free trial it has not decided on', () => {
    expect(copy).not.toMatch(/[£$€]\s?\d|per month|\/mo\b|free trial|money.back/);
    expect(FAQ.find((f) => /cost/i.test(f.q))?.a).toMatch(/not set prices yet/i);
  });

  it('only claims "Works today" for the kind of site that really works today', () => {
    const now = CONNECTORS.filter((c) => c.availability === 'now');
    expect(now).toHaveLength(1);
    expect(now[0]!.name).toMatch(/github/i);
    for (const c of CONNECTORS.filter((c) => /wordpress|shopify|wix|squarespace/i.test(c.name))) expect(c.availability).not.toBe('now');
  });

  it('agrees with the server about which kinds of site are ready, so the page and the check never disagree', () => {
    const forPlatform = (p: Platform) => platformAdvice(p).availability;
    const listed = (re: RegExp) => CONNECTORS.find((c) => re.test(c.name))!.availability;
    expect(listed(/github/i)).toBe(forPlatform('astro'));
    expect(listed(/wordpress/i)).toBe(forPlatform('wordpress'));
    expect(listed(/shopify/i)).toBe(forPlatform('shopify'));
    expect(listed(/shopify/i)).toBe(forPlatform('wix'));
    expect(listed(/squarespace/i)).toBe(forPlatform('squarespace'));
    expect(listed(/anything else/i)).toBe(forPlatform('unknown'));
    for (const a of ['now', 'soon', 'later', 'ask'] as const) expect(AVAILABILITY_LABEL[a]).toBeTruthy();
  });

  it('numbers only the steps that are a real sequence, and points the proof at a real https page on the right site', () => {
    expect(STEPS).toHaveLength(3);
    expect(new URL(PROOF.href).protocol).toBe('https:');
    expect(new URL(PROOF.href).hostname).toBe('plerosis.com');
  });
});

describe('turning a site check into sentences', () => {
  it('reads naturally for every mix, and leaves out what is zero', () => {
    expect(summaryLine({ good: 5, fix: 2, info: 1 })).toBe('5 things look fine, 2 are worth fixing and 1 is worth a look.');
    expect(summaryLine({ good: 1, fix: 1, info: 0 })).toBe('1 thing looks fine and 1 is worth fixing.');
    expect(summaryLine({ good: 0, fix: 3, info: 0 })).toBe('3 are worth fixing.');
    expect(summaryLine({ good: 4, fix: 0, info: 0 })).toBe('4 things look fine.');
    expect(summaryLine({ good: 0, fix: 0, info: 0 })).toMatch(/could not find much/);
  });

  it('puts problems first and keeps every finding', () => {
    const f = (id: string, level: FindingView['level']): FindingView => ({ id, level, title: id, detail: '' });
    const g = groupFindings([f('a', 'good'), f('b', 'fix'), f('c', 'info'), f('d', 'fix')]);
    expect(g.fix.map((x) => x.id)).toEqual(['b', 'd']);
    expect(g.info.map((x) => x.id)).toEqual(['c']);
    expect(g.good.map((x) => x.id)).toEqual(['a']);
  });

  it('says what a site is built with as a guess, and admits when it cannot tell', () => {
    expect(builtWithLine('acme.com', 'wordpress', 'WordPress')).toBe('acme.com looks like it is built with WordPress.');
    expect(builtWithLine('acme.com', 'unknown', 'something we could not identify')).toBe('We could not tell what acme.com is built with.');
  });
});

describe('who gets the front page', () => {
  it('sends people arriving from a sign-in email, GitHub or the Sign in link to the inbox', () => {
    for (const here of ['?signin=1', '?connect=pick', '?connect=error&reason=x', '#access_token=abc&type=magiclink', '#error_description=Link+expired', '?code=abc123', '?x=1&code=abc', '#refresh_token=zzz'])
      expect(arrivingFromLink(here), here).toBe(true);
  });

  it('gives everyone else the front page, including links that merely look similar', () => {
    for (const here of ['', '?utm_source=tiktok', '#join', '#privacy', '?barcode=1', '?signing=1', '?demo=1']) expect(arrivingFromLink(here), here).toBe(false);
  });

  it('opens the sample inbox only when asked', () => {
    expect(wantsDemo('?demo=1')).toBe(true);
    expect(wantsDemo('?demo')).toBe(true);
    expect(wantsDemo('#demo')).toBe(true);
    expect(wantsDemo('?x=1&demo=1')).toBe(true);
    expect(wantsDemo('')).toBe(false);
    expect(wantsDemo('#join')).toBe(false);
    expect(wantsDemo('?demonstration=1')).toBe(false);
    expect(wantsDemo('#demonstration')).toBe(false);
  });
});
