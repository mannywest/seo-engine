/**
 * Plain-English reasons the Connect flow can stop, shared by the server piece (which sends the short code in the address)
 * and the screen (which shows the sentence). One list, so the two can never disagree.
 */
export const REASONS = {
  denied: 'You chose not to allow access on GitHub, so nothing was connected.',
  expired: 'That link has expired or was already used. Tap Connect to start again.',
  invalid: 'That link did not check out, so nothing was connected. Tap Connect to start again.',
  github_failed: 'GitHub did not answer properly. Nothing was connected. Please try again in a minute.',
  not_yours: 'We could not confirm that you have access to that GitHub installation, so nothing was connected.',
  no_repos: 'GitHub did not give Lodestar access to any repository you can write to. Tap Connect and choose the one that holds your website.',
  app_missing: 'Connecting is not set up yet. The one-time GitHub App set-up still needs doing.',
  app_exists: 'The GitHub App has already been created, so nothing was changed.',
  convert_failed: 'GitHub did not finish creating the app. Nothing was saved. You can try again.',
  save_failed: 'The app was created on GitHub but its key could not be saved. Delete the app on GitHub and try again.',
  server: 'Something went wrong on our side. Nothing was connected. Please try again.',
} as const;

export type ReasonCode = keyof typeof REASONS;

export function reasonText(code: string | null | undefined): string {
  return code && code in REASONS ? REASONS[code as ReasonCode] : REASONS.server;
}
