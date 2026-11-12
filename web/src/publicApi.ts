import type { Availability, FindingView, Summary } from './landingCopy';

/** What the page gets back from POST /api/site-check. Mirrors SiteCheckResult in worker/publicApi.ts. */
export interface SiteReport {
  site: string;
  platform: string;
  platformName: string;
  availability: Availability;
  advice: string;
  title: string;
  findings: FindingView[];
  summary: Summary;
  note: string;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * A preview build (VITE_PREVIEW=1) answers from sample data instead of the server, so the whole page can be tried on a
 * phone before the server side is switched on. It says so on screen. The real build never does this.
 */
export const PREVIEW = import.meta.env.VITE_PREVIEW === '1';

const SAMPLE: SiteReport = {
  site: 'your-site.co.uk',
  platform: 'unknown',
  platformName: 'something we could not identify',
  availability: 'ask',
  advice: 'We could not tell what this site is built on. Tell us when you sign up and we will check. You can always copy or download any approved article.',
  title: 'Sample result',
  findings: [
    { id: 'description', level: 'fix', title: 'The home page has no description', detail: 'The short summary under the title in search results is missing, so Google picks a random snippet.' },
    { id: 'alt', level: 'fix', title: '2 of 9 images have no description', detail: 'Image descriptions help people using screen readers and help search engines understand pictures.' },
    { id: 'blog', level: 'info', title: 'We did not find a blog or news section', detail: 'Regular helpful articles are how most small sites get found. There is no obvious place for them yet.' },
    { id: 'https', level: 'good', title: 'The site uses a secure connection', detail: 'The address starts with https, which visitors and search engines expect.' },
    { id: 'mobile', level: 'good', title: 'Set up for phones', detail: 'The page tells phones how to fit it to the screen.' },
  ],
  summary: { good: 2, fix: 2, info: 1 },
  note: 'This is a quick look at your home page only. It is not a ranking and promises nothing about where you will appear in Google.',
};

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> | undefined }> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data: Record<string, unknown> | undefined;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    data = undefined; // not our server (a plain preview, or an outage page)
  }
  return { status: res.status, data };
}

const messageOf = (data: Record<string, unknown> | undefined, fallback: string) => (typeof data?.error === 'string' ? data.error : fallback);

export async function checkSite(url: string): Promise<Outcome<SiteReport>> {
  if (PREVIEW) {
    await pause(900);
    return { ok: true, value: { ...SAMPLE, site: url.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || SAMPLE.site } };
  }
  try {
    const { status, data } = await post('/api/site-check', { url });
    if (status === 200 && data?.ok === true) return { ok: true, value: data as unknown as SiteReport };
    return { ok: false, message: messageOf(data, 'The checker is not available right now. Please try again in a minute.') };
  } catch {
    return { ok: false, message: 'We could not reach our server. Check your connection and try again.' };
  }
}

export async function joinWaitingList(input: { email: string; url: string; consent: boolean; company: string }): Promise<Outcome<true>> {
  if (PREVIEW) {
    await pause(600);
    return { ok: true, value: true };
  }
  try {
    const { status, data } = await post('/api/signup', input);
    if (status === 200 && data?.ok === true) return { ok: true, value: true };
    return { ok: false, message: messageOf(data, 'We could not save that just now. Please try again in a minute.') };
  } catch {
    return { ok: false, message: 'We could not reach our server. Check your connection and try again.' };
  }
}
