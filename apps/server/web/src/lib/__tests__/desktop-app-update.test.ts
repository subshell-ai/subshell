import { describe, expect, it } from "bun:test";
import { appUpdateNotice, type DesktopAppUpdate } from "../desktop-app-update";

/**
 * What the footer row announces about the app hosting the page.
 *
 * The dismissal these tests used to cover is gone with the two-line block it
 * silenced (operator's call, 2026-09-18): the row is one line that always
 * names the version and carries a dot when there is news, so there is nothing
 * loud left to dismiss. `appUpdateRowVisible`, `readDismissedAppUpdate`,
 * `rememberAppUpdateDismissal` and `DISMISSED_APP_UPDATE_KEY` went with it.
 *
 * What did NOT go is the equal-versions backstop, which is the one rule here
 * worth a test of its own — see below.
 */
function update(over: Partial<DesktopAppUpdate> = {}): DesktopAppUpdate {
  return { currentVersion: "0.7.2", availableVersion: null, ...over };
}

describe("appUpdateNotice", () => {
  it("announces a version newer than the one running", () => {
    expect(appUpdateNotice(update({ availableVersion: "0.8.0" }))).toBe("0.8.0");
  });

  it("announces nothing when no update is known — which is NOT 'up to date'", () => {
    // Covers "never checked" and "checked, found nothing" alike. The row still
    // renders the version; it just carries no dot.
    expect(appUpdateNotice(update())).toBeNull();
  });

  /**
   * The BACKSTOP, and the reason this function did not collapse into a null
   * check (review 2026-09-17). The shell already answers `availableVersion:
   * null` once the stored notice names what is running — but a NEW page can
   * meet an OLD binary whose stored value outlived the install it announced:
   * in-app, where the notice was never cleared before the restart, or by hand,
   * where the `.app` was replaced from a downloads page and nothing touched
   * `settings.json`. A dot beside a 0.8.0 app for 0.8.0 is the lie either half
   * alone lets through.
   */
  it("announces nothing when the 'available' version is the one already running", () => {
    expect(appUpdateNotice({ currentVersion: "0.8.0", availableVersion: "0.8.0" })).toBeNull();
  });

  it("still announces an older-numbered current against a newer available", () => {
    // Not a semver comparison and deliberately not: the shell owns that
    // judgement (`notice_for` in Rust, which uses `version_lt`). This function
    // guards the one shape Rust cannot see — a payload from a binary that
    // never cleared its stored answer.
    expect(appUpdateNotice({ currentVersion: "0.9.0", availableVersion: "0.10.0" })).toBe("0.10.0");
  });

  it("announces nothing before the shell answers, or when it answered nothing", () => {
    // A browser, a build predating `desktop_app_update`, or the read in
    // flight. The ROW renders nothing at all in that case; this is the model
    // half of the same fact.
    expect(appUpdateNotice(null)).toBeNull();
    expect(appUpdateNotice(undefined)).toBeNull();
  });
});
