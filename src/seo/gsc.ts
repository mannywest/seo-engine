export interface GscRow {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const num = (s: string | undefined) => Number((s ?? '').replace(/[%,\s]/g, '')) || 0;

/** Parses the Queries.csv (or Pages.csv) file from Google Search Console's "Export" button. Free, no API setup. */
export function parseGscCsv(text: string): GscRow[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const idx = (re: RegExp) => header.findIndex((h) => re.test(h.toLowerCase()));
  const q = idx(/quer|page|top/);
  const c = idx(/click/);
  const im = idx(/impression/);
  const ct = idx(/ctr/);
  const p = idx(/position/);
  return rows.map((r) => {
    const ctrRaw = r[ct] ?? '';
    return {
      query: (r[q] ?? '').trim(),
      clicks: num(r[c]),
      impressions: num(r[im]),
      ctr: ctrRaw.includes('%') ? num(ctrRaw) / 100 : num(ctrRaw),
      position: num(r[p]),
    };
  });
}

// Rough rule-of-thumb click rates by position, used only to rank opportunities, not as a forecast.
const EXPECTED_CTR = [0.28, 0.15, 0.1, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02, 0.02];

export interface Opportunities {
  /** Ranking on page 1-2 but not top results: a better or new article can lift them. */
  strikingDistance: GscRow[];
  /** Ranking well but few clicks: improve the title and meta description. */
  lowCtr: GscRow[];
  /** Many impressions, deep position: the site has no strong page for these. */
  contentGaps: GscRow[];
}

export function findOpportunities(rows: GscRow[], minImpressions = 50): Opportunities {
  const by = (a: GscRow, b: GscRow) => b.impressions - a.impressions;
  const strikingDistance = rows.filter((r) => r.position > 7 && r.position <= 20 && r.impressions >= minImpressions).sort(by);
  const lowCtr = rows
    .filter((r) => r.position >= 1 && r.position <= 10 && r.impressions >= minImpressions * 2)
    .filter((r) => r.ctr < (EXPECTED_CTR[Math.min(9, Math.max(0, Math.round(r.position) - 1))] ?? 0.02) * 0.5)
    .sort(by);
  const contentGaps = rows.filter((r) => r.position > 20 && r.impressions >= minImpressions).sort(by);
  return { strikingDistance, lowCtr, contentGaps };
}
