/**
 * Reading the one GitHub secret (SECRETS_JSON) that can carry any number of keys, so adding a key never needs a workflow edit.
 *
 * Two shapes are accepted:
 *   1. JSON:        {"GROQ_API_KEY":"gsk_abc"}
 *   2. Plain lines: GROQ_API_KEY=gsk_abc   (one per line)
 * The plain lines exist because typing JSON on a phone often swaps the straight quotes for curly ones, which breaks it.
 */
export function parseSecretsBlob(blob: string | undefined): Record<string, string> {
  if (!blob || !blob.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(blob);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
      return out;
    }
  } catch {
    /* not JSON: try plain lines */
  }
  const out: Record<string, string> = {};
  for (const raw of blob.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if (/^(["'“‘]).*(["'”’])$/.test(value) && value.length >= 2) value = value.slice(1, -1);
    if (value) out[m[1]!] = value;
  }
  return out;
}

/** Backup AIs to try when the main one fails. Groq is the default; it is skipped on its own when no GROQ_API_KEY is set. */
export function parseFallbackList(v: string | undefined): string[] {
  const list = (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return list.length ? list : ['groq'];
}
