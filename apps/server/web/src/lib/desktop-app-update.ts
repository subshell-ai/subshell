/**
 * What the shell's own app update looks like from the page (spec 2026-09-17 §5.3).
 *
 * The model lives here rather than in the row because the HOOK needs the shape
 * to validate an IPC answer and the row needs the dismissal rule — importing
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
   * "up to date"; it renders no affordance at all.
   */
  availableVersion: string | null;
}

/**
 * sessionStorage key holding the version the person dismissed (spec §5.3).
 *
 * Session, not local: "Later" means later in this run, and quitting is what
 * re-asks. One key holding the version string, because this row is the server
 * app's own surface — a second app with its own updater row would want a key of
 * its own, not a value that has to name which app it belongs to.
 */
export const DISMISSED_APP_UPDATE_KEY = "subshell:dismissed-app-update";

/** The dismissed version, or `null` — including when storage itself throws. */
export function readDismissedAppUpdate(): string | null {
  try {
    return sessionStorage.getItem(DISMISSED_APP_UPDATE_KEY);
  } catch {
    // Private-mode oddities: a page that cannot remember the dismissal still
    // shows the row, which is the safe direction of forgetting.
    return null;
  }
}

/** Record that THIS version was dismissed. Never throws; may not persist. */
export function rememberAppUpdateDismissal(version: string): void {
  try {
    sessionStorage.setItem(DISMISSED_APP_UPDATE_KEY, version);
  } catch {
    // Storage unavailable — the dismissal holds for this render, which is all
    // the press promised.
  }
}

/**
 * Whether the footer row renders.
 *
 * Four ways it does not: the shell has not answered (a browser, an older
 * binary with no such command, or the read still in flight), the answer carries
 * no known update, the answer names the version that is ALREADY running, or
 * this exact version was dismissed. A dismissal is bound to the version, so a
 * newer release re-shows the row without any expiry logic — that is the whole
 * "snooze until it changes" mechanism, in one comparison.
 *
 * The equal-versions guard is a BACKSTOP, not a restatement of the shell's
 * filter (review 2026-09-17): the app read now answers `availableVersion: null`
 * when the stored notice names what is running, but a NEW page can meet an OLD
 * binary whose stored value outlived the install it announced — in-app (the
 * notice was never cleared before restart) or by hand (the `.app` was replaced
 * from a downloads page, and nothing cleared `settings.json`). "v0.8.0
 * available" beside a v0.8.0 app is the lie either half alone lets through;
 * the payload carries both versions precisely so this line can refuse it.
 */
export function appUpdateRowVisible(update: DesktopAppUpdate | null | undefined, dismissed: string | null): boolean {
  if (update === null || update === undefined) return false;
  const available = update.availableVersion ?? null;
  return available !== null && available !== update.currentVersion && dismissed !== available;
}
