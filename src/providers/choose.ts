import { FallbackProvider } from './fallback.js';
import { AnthropicProvider, type LlmProvider } from './llm.js';
import { OllamaProvider } from './ollama.js';
import { OpenAiCompatProvider } from './openai.js';

export interface LlmChoice {
  llm: string;
  model?: string;
  baseUrl?: string;
  /** Backup AIs, in order, used if the main one is down or overloaded. Ones with no key set are skipped. */
  fallback?: string[];
}

const PRESETS: Record<string, { baseUrl: string; model: string; keyEnv: string }> = {
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash', keyEnv: 'GEMINI_API_KEY' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keyEnv: 'GROQ_API_KEY' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free', keyEnv: 'OPENROUTER_API_KEY' },
};

/** Picks the AI that writes the articles. Model names change often, so any preset can be overridden with --model. */
export function chooseLlm(c: LlmChoice, env = process.env): LlmProvider {
  const main = chooseOne(c, env);
  const backups: LlmProvider[] = [];
  for (const name of c.fallback ?? []) {
    if (name === c.llm) continue;
    try {
      backups.push(chooseOne({ llm: name }, env));
    } catch {
      // No key for this backup: skip it rather than stop the run.
    }
  }
  return backups.length ? new FallbackProvider([main, ...backups]) : main;
}

function chooseOne(c: LlmChoice, env = process.env): LlmProvider {
  if (c.llm === 'ollama') return new OllamaProvider(c.model ?? 'llama3.1', c.baseUrl);
  if (c.llm === 'anthropic') {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('anthropic needs ANTHROPIC_API_KEY (this spends money). Use ollama, gemini or groq for free options.');
    return new AnthropicProvider(key, c.model);
  }
  const preset = PRESETS[c.llm];
  if (preset) {
    const key = env[preset.keyEnv];
    if (!key) throw new Error(`${c.llm} needs ${preset.keyEnv} (a free key from that service).`);
    return new OpenAiCompatProvider(key, c.model ?? preset.model, c.baseUrl ?? preset.baseUrl);
  }
  if (c.llm === 'openai-compatible') {
    const key = env.LLM_API_KEY;
    if (!key || !c.baseUrl || !c.model) throw new Error('openai-compatible needs LLM_API_KEY plus --base-url and --model.');
    return new OpenAiCompatProvider(key, c.model, c.baseUrl);
  }
  throw new Error(`Unknown --llm "${c.llm}". Options: ollama, gemini, groq, openrouter, anthropic, openai-compatible.`);
}
