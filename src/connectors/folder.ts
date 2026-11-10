import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Connector, PublishContext, PublishItem, PublishResult } from './types.js';

/** Writes markdown files into a local folder. Useful for testing, or when another tool syncs that folder. */
export class FolderConnector implements Connector {
  readonly type = 'folder';
  constructor(private dir: string) {}
  async check() {
    return [];
  }
  async publish(items: PublishItem[], _ctx: PublishContext): Promise<PublishResult[]> {
    await mkdir(this.dir, { recursive: true });
    const out: PublishResult[] = [];
    for (const i of items) {
      const path = join(this.dir, `${i.slug}.md`);
      await writeFile(path, i.markdown, 'utf8');
      out.push({ slug: i.slug, ok: true, url: path });
    }
    return out;
  }
}
