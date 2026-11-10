import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface HistoryEntry {
  slug: string;
  title: string;
  keyword: string;
  createdAt: string;
  passed: boolean;
  score: number;
  /** Where it was delivered (PR, WordPress post...) if a connector ran. */
  deliveredTo?: string;
}

/** The engine's memory of what it has already written for one client, so topics never repeat across runs. */
export class History {
  constructor(
    public entries: HistoryEntry[],
    private path: string,
  ) {}

  static async load(clientId: string, dataDir = 'data'): Promise<History> {
    const path = join(dataDir, clientId, 'history.json');
    try {
      return new History(JSON.parse(await readFile(path, 'utf8')) as HistoryEntry[], path);
    } catch {
      return new History([], path);
    }
  }

  slugs(): string[] {
    return this.entries.map((e) => e.slug);
  }

  add(e: HistoryEntry) {
    this.entries.push(e);
  }

  lastRun(): Date | null {
    if (!this.entries.length) return null;
    return new Date(Math.max(...this.entries.map((e) => Date.parse(e.createdAt))));
  }

  /** True when enough days have passed to honour the client's articles-per-week cadence. */
  isDue(cadencePerWeek: number, now = new Date()): boolean {
    if (cadencePerWeek <= 0) return false;
    const last = this.lastRun();
    if (!last) return true;
    const minDays = 7 / cadencePerWeek;
    return (now.getTime() - last.getTime()) / 86_400_000 >= minDays - 0.1;
  }

  async save() {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.entries, null, 2) + '\n', 'utf8');
  }
}
