import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { sha256 } from './hash.js';
import type { Connector, PublishContext, PublishItem, PublishResult, RevertContext, RevertResult } from './types.js';

const Handle = z.object({
  path: z.string(),
  /** What the file held before we wrote it, or null if it did not exist. */
  previous: z.string().nullable(),
  /** Fingerprint of what we wrote, to detect later edits. */
  sha256: z.string(),
});

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

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
      const previous = await readFile(path, 'utf8').catch((e) => {
        if (isMissing(e)) return null;
        throw e;
      });
      await writeFile(path, i.markdown, 'utf8');
      out.push({ slug: i.slug, ok: true, url: path, handle: { path, previous, sha256: sha256(i.markdown) } satisfies z.infer<typeof Handle> });
    }
    return out;
  }

  /** Puts the folder back as it was. Whatever is replaced or removed is kept in a ".reverted" folder, never deleted. */
  async revert(handle: Record<string, unknown>, ctx: RevertContext): Promise<RevertResult> {
    const h = Handle.parse(handle);
    const current = await readFile(h.path, 'utf8').catch((e) => {
      if (isMissing(e)) return null;
      throw e;
    });
    if (current === null) return { ok: true, note: 'The file was already gone, so there was nothing to undo.' };
    if (sha256(current) !== h.sha256 && !ctx.force) {
      return { ok: false, refused: true, note: 'The file has been changed since it was delivered, so it was left alone. Undo it with force if you are sure.' };
    }
    const keep = join(dirname(h.path), '.reverted');
    await mkdir(keep, { recursive: true });
    const aside = join(keep, `${basename(h.path, '.md')}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    if (h.previous !== null) {
      await copyFile(h.path, aside);
      await writeFile(h.path, h.previous, 'utf8');
      return { ok: true, note: `Restored the previous version of the file. The replaced version is kept in ${keep}.` };
    }
    await rename(h.path, aside);
    return { ok: true, note: `Took the file out of the folder. It is kept in ${keep}, not deleted.` };
  }
}
