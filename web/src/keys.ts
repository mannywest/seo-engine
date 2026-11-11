/**
 * The web app must only ever hold the public ("anon") key. The service key can read and change everything,
 * so if one is found here the app refuses to start rather than ship it to every visitor's browser.
 */
export function isServiceKey(key: string): boolean {
  const k = key.trim();
  if (k.startsWith('sb_secret_')) return true;
  const part = k.split('.')[1];
  if (!part) return false;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))) as { role?: unknown };
    return json.role === 'service_role';
  } catch {
    return false;
  }
}
