/**
 * What the shell's own app update looks like from the page (spec 2026-09-17 §5.3).
 *
 * The model lives here rather than in the row because the HOOK needs the shape
 * to validate an IPC answer and the row needs the notice rule — importing
 * either from a component would make a value-level cycle, the same reason
 * `lib/supervision.ts` holds `currentMode`.
 */

/** What `desktop_app_update` answers: the app's version, and what it could be. */
export interface DesktopAppUpdate {
  /** The shell's own version, e.g. `0.7.2` — never the server's. */
  currentVersion: string;
  /**
   * The newest release the daily check found, or `null` for "no known update"
   * — which includes "never checked". Nothing on screen reads the null as
   * "up to date".
   */
  availableVersion: string | null;
}

/**
 * The version to announce beside the running one, or `null` for nothing to say.
 *
 * **The equal-versions guard is a BACKSTOP, not a restatement of the shell's
 * own filter** (review 2026-09-17). The app read answers `availableVersion:
 * null` when the stored notice names what is running, but a NEW page can meet
 * an OLD binary whose stored value outlived the install it announced —
 * in-app, where the notice was never cleared before the restart, or by hand,
 * where the `.app` was replaced from a downloads page and nothing touched
 * `settings.json`. A dot beside a v0.8.0 app for v0.8.0 is the lie either half
 * alone lets through; the payload carries both versions precisely so this line
 * can refuse it.
 *
 * **The dismissal is gone** (operator's call, 2026-09-18). This used to be
 * `appUpdateRowVisible(update, dismissed)`, deciding whether a two-line block
 * with an [Update] button and a × appeared at all, with the × writing the
 * dismissed version to `sessionStorage`. The row is now one line that always
 * renders the version and merely carries a dot when there is news, so there is
 * no longer anything loud to silence — and a dot you can switch off is a
 * status light that lies. `DISMISSED_APP_UPDATE_KEY`, `readDismissedAppUpdate`
 * and `rememberAppUpdateDismissal` went with it.
 *
 * @param update - What the shell answered, or null/undefined if it has not
 * @returns The newer version, or null when there is nothing to announce
 */
export function appUpdateNotice(update: DesktopAppUpdate | null | undefined): string | null {
  if (update === null || update === undefined) return null;
  const available = update.availableVersion ?? null;
  return available !== null && available !== update.currentVersion ? available : null;
}
