import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import profileJson from '../clients/plerosis.json' with { type: 'json' };
import { FactsVault, type FactKind } from '../src/facts.js';
import { findBusinessClaims, guardDraft } from '../src/guard.js';
import { writeDraft } from '../src/pipeline/draft.js';
import { checkDraft } from '../src/pipeline/quality.js';
import { runPipeline } from '../src/pipeline/run.js';
import { buildProof, renderProof } from '../src/proof.js';
import { MockProvider, type LlmRequest } from '../src/providers/llm.js';
import { MockSearch } from '../src/providers/search.js';
import type { ClientProfile, Draft } from '../src/types.js';

const profile = profileJson as ClientProfile;
const NOW = new Date('2026-11-10T00:00:00Z');

function vaultOf(...facts: [FactKind, string, string][]): FactsVault {
  const v = new FactsVault([], 'unused');
  for (const [kind, label, value] of facts) v.upsert({ kind, label, value }, NOW);
  return v;
}
const guard = (body: string, v: FactsVault) => guardDraft(body, v, { businessName: 'Acme Plumbing', now: NOW });
const issuesOf = (body: string, v: FactsVault) => guard(body, v).issues.join(' | ');

function goodDraft(extra = ''): Draft {
  const filler = 'word '.repeat(300);
  const body = [
    `Direct answer paragraph. ${filler}`,
    '## First section',
    `See [what we do](/what-we-do). ${filler}`,
    '## Second section',
    `Read [how we work](/how-we-work). ${filler}`,
    '## Third section',
    filler,
    ...(extra ? [extra] : []),
    '## Frequently asked questions',
    '**Question?** Answer.',
  ].join('\n\n');
  return {
    topic: { title: 'A good title', slug: 'a-good-title', keyword: 'k', intent: 'info', outline: ['a', 'b', 'c'] },
    title: 'A good title',
    description: 'A meta description that is comfortably between seventy and one hundred and sixty characters long.',
    body,
    tags: [],
    sources: [{ title: 's', url: 'https://example.com', snippet: 'No figures here.' }],
  };
}

describe('facts vault', () => {
  it('treats a missing file as an empty vault, and round-trips a saved one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vault-'));
    const empty = await FactsVault.load('acme', dir);
    expect(empty.isEmpty).toBe(true);
    empty.upsert({ kind: 'hours', label: 'Opening hours', value: 'Mon-Fri 8am-6pm' }, NOW);
    await empty.save();
    const again = await FactsVault.load('acme', dir);
    expect(again.facts).toEqual([{ id: 'hours-opening-hours', kind: 'hours', label: 'Opening hours', value: 'Mon-Fri 8am-6pm', verifiedAt: '2026-11-10' }]);
  });

  it('refuses a file that exists but is invalid instead of ignoring it', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const dir = await mkdtemp(join(tmpdir(), 'vault-'));
    await mkdir(join(dir, 'acme'), { recursive: true });
    await writeFile(join(dir, 'acme', 'facts.json'), JSON.stringify([{ id: 'x', kind: 'hours', label: 'Hours', value: 'x', verifiedAt: 'yesterday' }]));
    await expect(FactsVault.load('acme', dir)).rejects.toThrow(/not a valid facts file/);
  });

  it('replaces a fact with the same id, removes by id and finds stale facts', () => {
    const v = vaultOf(['price', 'Boiler service', '£79']);
    v.upsert({ kind: 'price', label: 'Boiler service', value: '£89' }, NOW);
    expect(v.facts).toHaveLength(1);
    expect(v.facts[0]?.value).toBe('£89');
    v.upsert({ kind: 'hours', label: 'Opening hours', value: '8am-6pm', verifiedAt: '2026-01-01' }, NOW);
    expect(v.stale(NOW).map((f) => f.label)).toEqual(['Opening hours']);
    expect(v.remove('price-boiler-service')).toBe(true);
    expect(v.remove('nope')).toBe(false);
  });

  it('tells the writer what it may and may not state', () => {
    expect(new FactsVault([], 'x').promptBlock()).toMatch(/No verified business facts/);
    const block = vaultOf(['price', 'Boiler service', '£79']).promptBlock();
    expect(block).toContain('ONLY facts');
    expect(block).toContain('- Boiler service: £79');
  });
});

describe('answer guard: opening hours', () => {
  const v = vaultOf(['hours', 'Opening hours', 'Mon-Fri 8am-6pm']);
  it('accepts confirmed hours', () => {
    expect(guard('We are open from 8am to 6pm Monday to Friday.', v).issues).toEqual([]);
  });
  it('blocks hours that differ from the confirmed ones', () => {
    expect(issuesOf('We are open until 9pm every weekday.', v)).toMatch(/do not match the confirmed opening hours/);
  });
  it('blocks any stated hours when none are confirmed', () => {
    expect(issuesOf('We are open from 8am to 6pm.', new FactsVault([], 'x'))).toMatch(/no opening hours are confirmed/);
  });
  it('blocks "open 24/7" unless it is a confirmed fact', () => {
    expect(issuesOf('We are open 24/7.', v)).toMatch(/always open/);
    expect(guard('We are open 24/7.', vaultOf(['hours', 'Emergency line', 'Open 24/7 for emergencies'])).issues).toEqual([]);
  });
});

describe('answer guard: prices, contact details and areas', () => {
  it('checks prices the business states as its own, and only those', () => {
    const v = vaultOf(['price', 'Boiler service', '£79']);
    expect(guard('Our boiler service costs £79.', v).issues).toEqual([]);
    expect(issuesOf('Our boiler service costs £49.', v)).toMatch(/£49/);
    expect(issuesOf('Our service costs £79 and our call-out is £60.', v)).toMatch(/£60/);
    // A general figure not in the business's own voice is left to the source check.
    expect(guard('A typical boiler service costs £49 in the UK.', v).issues).toEqual([]);
  });

  it('matches phone numbers across formats and blocks unknown contact details', () => {
    const v = vaultOf(['contact', 'Contact', 'Phone 020 7946 0958, email hello@acme.test']);
    expect(guard('Call us on +44 20 7946 0958 or email hello@acme.test.', v).issues).toEqual([]);
    expect(issuesOf('Email sales@other.test.', v)).toMatch(/sales@other\.test/);
    expect(issuesOf('Ring 07700 900123 today.', v)).toMatch(/07700 900123/);
    expect(guard('![Our logo](/img/logo@2x.png)', v).issues).toEqual([]);
  });

  it('holds service areas to the confirmed list', () => {
    const v = vaultOf(['area', 'Areas covered', 'London, Kent and Essex']);
    expect(guard('We cover London and Kent.', v).issues).toEqual([]);
    expect(issuesOf('We cover Surrey.', v)).toMatch(/Surrey/);
    expect(guard('We work Monday to Friday.', v).issues).toEqual([]);
    const none = guard('We cover Surrey.', new FactsVault([], 'x'));
    expect(none.issues).toEqual([]);
    expect(none.warnings.join(' ')).toMatch(/Surrey/);
  });
});

describe('answer guard: credentials, guarantees and history', () => {
  const v = vaultOf(
    ['guarantee', 'Quotes', 'Free no-obligation quotes'],
    ['credential', 'Insurance', 'Public liability insurance up to £5m'],
    ['other', 'Started', 'Established in 2004'],
  );
  it('accepts claims the business has confirmed', () => {
    expect(guard('We offer free quotes.', v).issues).toEqual([]);
    expect(guard('We are fully insured.', v).issues).toEqual([]);
    expect(guard('We have been trading since 2004.', v).issues).toEqual([]);
  });
  it('blocks claims it cannot match', () => {
    expect(issuesOf('We are Gas Safe registered.', v)).toMatch(/credential/);
    expect(issuesOf('We offer a 10-year guarantee.', v)).toMatch(/guarantee or promise/);
    expect(issuesOf('We have 20 years of experience.', v)).toMatch(/years in business/);
  });
  it('catches insurance claims however they are worded', () => {
    expect(issuesOf('We hold public liability insurance.', new FactsVault([], 'x'))).toMatch(/credential/);
    expect(guard('We hold public liability insurance.', v).issues).toEqual([]);
  });
  it('does not treat advice as a claim', () => {
    expect(guard('We recommend hiring a qualified electrician.', new FactsVault([], 'x')).issues).toEqual([]);
  });
  it('flags stale facts without blocking, and records the facts an article relied on', () => {
    const old = new FactsVault([], 'x');
    old.upsert({ kind: 'hours', label: 'Opening hours', value: 'Mon-Fri 8am-6pm', verifiedAt: '2026-01-01' }, NOW);
    const r = guard('We are open Mon-Fri 8am-6pm.', old);
    expect(r.issues).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/more than 6 months old/);
    expect(r.factsUsed.map((f) => f.label)).toEqual(['Opening hours']);
  });
  it('finds claims without needing a vault (reusable for checking what AI assistants say)', () => {
    const kinds = findBusinessClaims('We are open 9am to 5pm. Call 020 7946 0958. Our price is £50.').map((c) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(['times', 'phone', 'price']));
  });
});

describe('answer guard in the quality check and proof pack', () => {
  const v = vaultOf(['price', 'Boiler service', '£79 per visit']);

  it('accepts a confirmed price that no outside source mentions, and lists it in the proof pack', () => {
    const d = goodDraft('Our boiler service costs £79.');
    const without = checkDraft(d, profile);
    expect(without.issues.join(' ')).toMatch(/£79/); // unsupported without the vault
    const q = checkDraft(d, profile, { vault: v, now: NOW });
    expect(q.issues).toEqual([]);
    expect(q.factsUsed?.map((f) => f.label)).toEqual(['Boiler service']);
    expect(renderProof(buildProof(d, q, profile, 'mock'))).toContain('Boiler service: £79 per visit');
  });

  it('fails a draft that states something the vault does not back', () => {
    const q = checkDraft(goodDraft('We are fully insured.'), profile, { vault: v, now: NOW });
    expect(q.passed).toBe(false);
    expect(q.issues.join(' ')).toMatch(/credential/);
  });

  it('does not run when no vault is given', () => {
    expect(checkDraft(goodDraft('We are fully insured.'), profile).factsUsed).toBeUndefined();
  });
});

describe('vault in the writing prompt and the pipeline', () => {
  it('puts the confirmed facts in the instructions the writer sees', async () => {
    let seen = '';
    const llm = {
      name: 'fake',
      complete: async (r: LlmRequest) => {
        seen = r.system;
        return JSON.stringify({ title: 'A good title', description: 'A meta description that is comfortably between seventy and one hundred and sixty characters long.', body: 'Body text here that is long enough.', tags: [] });
      },
    };
    await writeDraft(profile, goodDraft().topic, [], llm, vaultOf(['price', 'Boiler service', '£79']));
    expect(seen).toContain('- Boiler service: £79');
  });

  async function runWith(extra: string, vault: FactsVault) {
    const dir = await mkdtemp(join(tmpdir(), 'trust-'));
    const mock = new MockProvider();
    const llm = {
      name: 'fake',
      complete: async (r: LlmRequest) =>
        r.task === 'plan'
          ? mock.complete(r)
          : JSON.stringify({ title: 'A good title', description: 'A meta description that is comfortably between seventy and one hundred and sixty characters long.', body: goodDraft(extra).body, tags: [] }),
    };
    const out = join(dir, 'out');
    const [result] = await runPipeline(profile, llm, new MockSearch(), { count: 1, outDir: out, mock: true, vault });
    const proof = await readFile(join(`${out}.proofs`, `${result?.slug}.proof.md`), 'utf8');
    return { result, proof };
  }

  it('holds back an unconfirmed claim and says so in the proof pack', async () => {
    const { result, proof } = await runWith('We are fully insured.', new FactsVault([], 'x'));
    expect(result?.quality.passed).toBe(false);
    expect(proof).toContain('FAILED');
    expect(proof).toContain('Claims a credential ("insured")');
  });

  it('passes a claim the business confirmed and names the fact it relied on', async () => {
    const { result, proof } = await runWith('We are fully insured.', vaultOf(['credential', 'Insurance', 'Public liability insurance up to £5m']));
    expect(result?.quality.passed).toBe(true);
    expect(proof).toContain('## Business facts relied on');
    expect(proof).toContain('Insurance: Public liability insurance up to £5m');
  });
});
