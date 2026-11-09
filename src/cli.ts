import { readFile } from 'node:fs/promises';
import { AnthropicProvider, MockProvider, type LlmProvider } from './providers/llm.js';
import { MockSearch, NotConfiguredSearch, type SearchProvider } from './providers/search.js';
import { runPipeline } from './pipeline/run.js';
import type { ClientProfile } from './types.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const [cmd, profilePath] = process.argv.slice(2);
  if (cmd !== 'run' || !profilePath) {
    console.log('Usage: tsx src/cli.ts run <client.json> [--mock | --live] [--count N] [--out DIR]');
    process.exit(1);
  }
  const profile = JSON.parse(await readFile(profilePath, 'utf8')) as ClientProfile;
  const count = Number(arg('count', '2'));
  const outDir = arg('out', `out/${profile.id}`)!;
  const mock = !flag('live');

  let llm: LlmProvider;
  let search: SearchProvider;
  if (mock) {
    llm = new MockProvider();
    search = new MockSearch();
    console.log('MOCK MODE: no AI calls, no cost. Output is placeholder text.\n');
  } else {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('--live needs ANTHROPIC_API_KEY (this spends money; approve first).');
    llm = new AnthropicProvider(key);
    search = new NotConfiguredSearch();
  }

  const results = await runPipeline(profile, llm, search, { count, outDir, mock });
  for (const r of results) {
    console.log(`${r.quality.passed ? 'PASS' : 'REVIEW'}  ${r.path}  (score ${r.quality.score})`);
    for (const issue of r.quality.issues) console.log(`   - ${issue}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
