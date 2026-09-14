/**
 * What macOS says about one of the desktop app's own permissions.
 *
 * A hand-written mirror of `desktop_permissions`' answer, which the shell
 * serializes from `desktop-core`'s `Permission` enum in kebab-case (spec
 * 2026-09-14 §4.1/§5.5). The words are the wire format, not a local spelling.
 *
 * - `not-determined` — macOS has not asked yet. It will, at the moment of use,
 *   which is why nothing in the dashboard says anything about this state.
 * - `denied` — asked and refused. macOS never asks again, so the only route
 *   back is System Settings.
 * - `authorized` / `provisional` — allowed (the second is the quiet delivery
 *   macOS grants without a prompt).
 * - `unavailable` — this build cannot answer. The real one is a bundled `.app`;
 *   `tauri dev` runs the bare binary, where the API would abort the process, so
 *   the shell reports this instead of asking. A shell too old to know the
 *   command reads the same way, and for the same reason: no answer exists.
 */
export type Permission = "not-determined" | "denied" | "authorized" | "provisional" | "unavailable";

/** Every {@link Permission} word, for iterating and for validating the wire. */
export const PERMISSIONS: readonly Permission[] = [
  "not-determined",
  "denied",
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
