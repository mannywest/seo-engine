const STOP = new Set(
  'a an and are as at be but by can do for from has have how i if in into is it its of on or our so than that the their them then there these they this to was we were what when where which who why will with you your about more most not out up'.split(
    ' ',
  ),
);

function stem(w: string): string {
  return w.replace(/(ing|ed|es|s)$/, (m, _g, off: number) => (off >= 3 ? '' : m));
}

/** Lower-cased, de-stopworded, lightly stemmed words. */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => (w.length > 1 || /\d/.test(w)) && !STOP.has(w))
    .map(stem);
}

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
