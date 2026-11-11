import { describe, expect, it } from 'vitest';
import profileJson from '../clients/plerosis.json' with { type: 'json' };
import { askForJson, toList } from '../src/pipeline/askJson.js';
import { writeDraft } from '../src/pipeline/draft.js';
import { planTopics } from '../src/pipeline/plan.js';
import type { LlmProvider, LlmRequest } from '../src/providers/llm.js';
import type { ClientProfile } from '../src/types.js';
import { z } from 'zod';

const profile = profileJson as ClientProfile;

/** An AI that gives the next reply from a list each time it is asked, and remembers what it was asked. */
function scripted(replies: string[]): LlmProvider & { asked: LlmRequest[] } {
  const asked: LlmRequest[] = [];
  return {
    name: 'scripted',
    asked,
    async complete(req) {
      asked.push(req);
      const r = replies.shift();
      if (r === undefined) throw new Error('scripted AI ran out of replies');
      return r;
    },
  };
}

const topic = (outline: unknown) => ({ title: 'How AI helps small firms', keyword: 'ai for small business', intent: 'informational', outline });

describe('turning text into a list', () => {
  it('splits lines, stripping bullets and numbers', () => {
    expect(toList('1. What it is\n2) How it works\n- Getting started')).toEqual(['What it is', 'How it works', 'Getting started']);
  });
  it('splits a numbered list written on one line', () => {
    expect(toList('1. What it is 2. How it works 3. Getting started')).toEqual(['What it is', 'How it works', 'Getting started']);
  });
  it('splits on pipes, semicolons and commas', () => {
    expect(toList('A | B | C')).toEqual(['A', 'B', 'C']);
    expect(toList('A; B; C')).toEqual(['A', 'B', 'C']);
    expect(toList('seo, local search, reviews')).toEqual(['seo', 'local search', 'reviews']);
  });
  it('leaves real lists and other values alone', () => {
    expect(toList(['a', 'b'])).toEqual(['a', 'b']);
    expect(toList(undefined)).toBeUndefined();
  });
});

describe('plan answers in the wrong shape', () => {
  it('accepts an outline sent as text (the Gemini reply that failed the first live run)', async () => {
    const llm = scripted([JSON.stringify({ topics: [topic('What it is\nHow it works\nGetting started')] })]);
    const topics = await planTopics(profile, llm, [], 1);
    expect(topics[0]!.outline).toEqual(['What it is', 'How it works', 'Getting started']);
    expect(llm.asked).toHaveLength(1);
  });
  it('asks again, naming the problem, when the reply cannot be used', async () => {
    const good = JSON.stringify({ topics: [topic(['One', 'Two', 'Three'])] });
    const llm = scripted(['Sorry, here is some chat and no JSON', good]);
    const topics = await planTopics(profile, llm, [], 1);
    expect(topics).toHaveLength(1);
    expect(llm.asked).toHaveLength(2);
    expect(llm.asked[1]!.prompt).toContain('could not be used');
    expect(llm.asked[1]!.prompt).toContain('no JSON object');
  });
  it('gives a readable error after two bad replies', async () => {
    const bad = JSON.stringify({ topics: [topic('just one item')] });
    const llm = scripted([bad, bad]);
    await expect(planTopics(profile, llm, [], 1)).rejects.toThrow(/topic plan was not in the expected format after 2 tries.*topics\.0\.outline/);
    expect(llm.asked).toHaveLength(2);
  });
  it('does not retry when the AI service itself fails', async () => {
    let calls = 0;
    const llm: LlmProvider = { name: 'down', complete: async () => (calls++, Promise.reject(new Error('LLM service returned 401'))) };
    await expect(planTopics(profile, llm, [], 1)).rejects.toThrow('401');
    expect(calls).toBe(1);
  });
});

describe('draft answers in the wrong shape', () => {
  const draft = (tags: unknown) =>
    JSON.stringify({
      title: 'A useful title here',
      description: 'A description that is long enough to pass the length check easily.',
      body: 'A body that is long enough to pass the schema check.',
      tags,
    });
  const t = { slug: 's', title: 'How AI helps small firms', keyword: 'ai for small business', intent: 'informational', outline: ['a', 'b', 'c'] };
  it('accepts tags sent as text', async () => {
    const d = await writeDraft(profile, t, [], scripted([draft('seo, local search')]));
    expect(d.tags).toEqual(['seo', 'local search']);
  });
  it('accepts a draft with no tags', async () => {
    const d = await writeDraft(profile, t, [], scripted([draft(undefined)]));
    expect(d.tags).toEqual([]);
  });
  it('asks again when the body is missing', async () => {
    const llm = scripted([JSON.stringify({ title: 'A useful title here' }), draft(['x'])]);
    const d = await writeDraft(profile, t, [], llm);
    expect(d.tags).toEqual(['x']);
    expect(llm.asked[1]!.prompt).toContain('description');
  });
});

describe('askForJson', () => {
  it('stops after the set number of tries', async () => {
    const llm = scripted(['no json', 'still none', 'never reached']);
    await expect(askForJson(llm, { task: 'plan', system: 's', prompt: 'p', maxTokens: 10 }, z.object({}), 'thing', 2)).rejects.toThrow('after 2 tries');
    expect(llm.asked).toHaveLength(2);
  });
});
