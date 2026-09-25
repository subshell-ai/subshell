/**
 * What macOS says about one of the desktop app's own permissions.
 *
 * A hand-written mirror of `desktop_permissions`' answer, which the shell
 * serializes from `desktop-core`'s `Permission` enum in kebab-case (spec
 * 2026-09-14 §4.1/§5.5). The words are the wire format, not a local spelling.
 *
 * - `not-determined` — macOS has not asked yet, and it will ask at the moment
 *   of use. That is true of all three prompts this app can provoke, each by a
 *   different route: posting the first notification when an agent waits raises
 *   the notification prompt in context; opening the Photos panel from the file
 *   picker raises the library prompt; and the SERVER's own first read of a
 *   protected folder raises the files prompt, attributed to whichever process
 *   did the reading (the binary under launchd, the app when it supervises its
 *   own child). Preferences still names the state for notifications, because
 *   someone who pressed Continue on first run without pressing Allow needs a
 *   route back to that button before an agent next waits.
 * - `denied` — asked and refused BY THE PERSON. macOS never asks again, so the
 *   only route back is System Settings, where their own row is.
 * - `restricted` — refused without the person being asked: a profile, Screen
 *   Time, or a Mac with no Photos library. Photos-only today, and there is no
 *   Settings row to fix, so surfaces must not offer one (2026-09-25).
 * - `authorized` / `provisional` — allowed (the second is the quiet delivery
 *   macOS grants without a prompt).
 * - `unavailable` — this build cannot answer. The real one is a bundled `.app`;
 *   `tauri dev` runs the bare binary, where the API would abort the process, so
 *   the shell reports this instead of asking. A shell too old to know the
 *   command reads the same way, and for the same reason: no answer exists.
 */
export type Permission = "not-determined" | "denied" | "restricted" | "authorized" | "provisional" | "unavailable";

/** Every {@link Permission} word, for iterating and for validating the wire. */
export const PERMISSIONS: readonly Permission[] = [
  "not-determined",
  "denied",
  "restricted",
  "authorized",
  "provisional",
  "unavailable",
];

/**
 * The whole of `desktop_permissions` — two facts about the app's standing with
 * the OS, from a command that takes no arguments and changes nothing.
 */
export interface DesktopPermissions {
  /** May the app post a notification when an agent is waiting. */
  notifications: Permission;
  /** May the app read an image the person picks from the Photos library. */
  photos: Permission;
}
