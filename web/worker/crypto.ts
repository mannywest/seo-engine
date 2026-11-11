/**
 * Signed, single-use "state" values for the trip to GitHub and back.
 *
 * The value a person carries is `nonce.signature`. The nonce is random and unguessable; the signature (HMAC-SHA256) proves
 * WE made it, so a forged or edited value is thrown away before the database is even asked. Single use and expiry are
 * enforced by the connect_attempts table (supabase/schema.sql), not here.
 */
const enc = new TextEncoder();

function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return undefined;
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

export function randomNonce(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toB64url(a);
}

/**
 * The signing key, derived from the service key so nobody has to invent and store one more secret.
 * Changing the service key invalidates any link that is mid-flight, which is the safe way to fail.
 */
export async function deriveStateKey(serviceKey: string): Promise<CryptoKey> {
  const root = await crypto.subtle.importKey('raw', enc.encode(serviceKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const raw = await crypto.subtle.sign('HMAC', root, enc.encode('lodestar-connect-state-v1'));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** `purpose` is signed in, so a value made for one job (connecting a site) cannot be replayed for another (creating the app). */
export async function signToken(key: CryptoKey, purpose: string, nonce: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${purpose}.${nonce}`));
  return `${nonce}.${toB64url(new Uint8Array(sig))}`;
}

/** The nonce inside a value we made for this purpose, or undefined when it is not genuine. Compares in constant time. */
export async function verifyToken(key: CryptoKey, purpose: string, token: string): Promise<string | undefined> {
  const dot = token.indexOf('.');
  if (dot < 1) return undefined;
  const nonce = token.slice(0, dot);
  const sig = fromB64url(token.slice(dot + 1));
  if (!sig || !/^[A-Za-z0-9_-]+$/.test(nonce)) return undefined;
  const ok = await crypto.subtle.verify('HMAC', key, sig, enc.encode(`${purpose}.${nonce}`));
  return ok ? nonce : undefined;
}
