import type { Fetch } from './connectors/types.js';

/**
 * Failure alerts. Set NOTIFY_WEBHOOK_URL to a Slack or Discord "incoming webhook" URL and every failed run posts there.
 * (On GitHub Actions a failed job also emails the repo owner by default, so this is a second safety net.)
 */
export async function notify(message: string, env = process.env, fetchFn: Fetch = fetch): Promise<boolean> {
  const url = env.NOTIFY_WEBHOOK_URL;
  if (!url) return false;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // "text" is read by Slack, "content" by Discord.
    body: JSON.stringify({ text: message, content: message }),
  }).catch(() => null);
  return !!res && res.ok;
}
