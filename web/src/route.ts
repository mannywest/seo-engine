/**
 * Who sees the front page and who goes straight to the inbox.
 * People arriving from a sign-in email, from GitHub, or from the Sign in link must reach the inbox even though they
 * are not signed in yet; everyone else who is signed out gets the front page.
 */
export function arrivingFromLink(searchAndHash: string): boolean {
  return /[?&#](signin|connect)=|access_token|refresh_token|error_description|[?&]code=/.test(searchAndHash);
}

/** The sample inbox is reached by ?demo=1 (shareable) or #demo (an in-page link, which also works inside a preview). */
export const wantsDemo = (searchAndHash: string): boolean => /[?&#]demo(=|&|$)/.test(searchAndHash);
