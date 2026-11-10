import { createHash } from 'node:crypto';

/** A fingerprint of some text, used to tell whether a delivered page has been changed since. */
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
