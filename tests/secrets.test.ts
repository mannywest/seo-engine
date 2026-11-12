import { describe, expect, it } from 'vitest';
import { chooseLlm } from '../src/providers/choose.js';
import { FallbackProvider } from '../src/providers/fallback.js';
import { parseFallbackList, parseSecretsBlob } from '../src/secrets.js';

describe('the one secret that carries many keys', () => {
  it('reads JSON', () => {
    expect(parseSecretsBlob('{"GROQ_API_KEY":"gsk_abc","N":1}')).toEqual({ GROQ_API_KEY: 'gsk_abc' });
  });
  it('reads one KEY=value per line, which survives phone typing', () => {
    expect(parseSecretsBlob('GROQ_API_KEY=gsk_abc\n# note\n\nOTHER = two words ')).toEqual({ GROQ_API_KEY: 'gsk_abc', OTHER: 'two words' });
  });
  it('copes with curly-quoted JSON by reading it as lines instead of failing silently', () => {
    expect(parseSecretsBlob('GROQ_API_KEY=“gsk_abc”')).toEqual({ GROQ_API_KEY: 'gsk_abc' });
  });
  it('treats empty or junk as nothing', () => {
    expect(parseSecretsBlob(undefined)).toEqual({});
    expect(parseSecretsBlob('   ')).toEqual({});
    expect(parseSecretsBlob('just some words')).toEqual({});
    expect(parseSecretsBlob('["a"]')).toEqual({});
  });
});

describe('backup AIs', () => {
  it('uses Groq as the backup unless told otherwise', () => {
    expect(parseFallbackList(undefined)).toEqual(['groq']);
    expect(parseFallbackList('')).toEqual(['groq']);
    expect(parseFallbackList('openrouter, groq')).toEqual(['openrouter', 'groq']);
  });
  it('adds Groq behind Gemini when a Groq key exists, and quietly skips it when not', () => {
    const withKey = chooseLlm({ llm: 'gemini', fallback: parseFallbackList(undefined) }, { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' } as NodeJS.ProcessEnv);
    expect(withKey).toBeInstanceOf(FallbackProvider);
    const noKey = chooseLlm({ llm: 'gemini', fallback: parseFallbackList(undefined) }, { GEMINI_API_KEY: 'g' } as NodeJS.ProcessEnv);
    expect(noKey).not.toBeInstanceOf(FallbackProvider);
  });
});
