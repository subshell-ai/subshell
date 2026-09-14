/**
 * What the permissions screen says (spec 2026-09-14 § 3, § 3.1).
 *
 * Four rows, in the order a first run meets them, each one a glyph, a label, a
 * sentence and at most one button. The whole screen is data here so its WORDS
 * are testable: they are the point of the feature — a person who has been told
 * what macOS is about to ask, and why, answers the sheet rather than dismissing
 * it — and a sentence that lives only inside a render is a sentence nothing
 * ever checks.
 *
 * Two rules run through all of it:
 *
 * - **Nothing here blocks.** Declining is a legitimate answer, so no row gates
 *   Continue and no row nags. The screen prepares; the recovery path (a denied
 *   row's Open System Settings, reachable forever afterwards) is what exists
 *   for changing your mind.
 * - **A button is offered only where pressing it does something.** macOS asks
 *   once, so "Allow" appears only while the state is `not-determined` and
 *   System Settings only once it is `denied`. Anything else is a control that
 *   silently no-ops, which teaches people that this screen's controls are
 *   decoration.
 */
import type { Permission, Probe, SettingsPane } from "./ipc";

/** The four rows, by the moment they arrive rather than by severity. */
export type PermissionRowId = "notifications" | "files" | "photos" | "login";

/**
 * A row's glyph state, borrowed from the setup checklist so "allowed" looks
 * the same everywhere this app says it. `active` is the spinner the
 * notifications row wears while its system sheet is up.
 */
export type PermissionRowState = "pending" | "done" | "failed" | "active";

/** What a row's button does, or `null` when it has none. */
export type PermissionAction = "allow" | "open-settings";

export interface PermissionRow {
  id: PermissionRowId;
  /** The permission's own name, as macOS spells it in System Settings. */
  label: string;
  /** What it is for and when it is asked — one or two plain sentences. */
  detail: string;
  state: PermissionRowState;
  /** The right-hand text: a state word, a "later", or empty. */
  suffix: string;
  action: PermissionAction | null;
  /**
   * Which System Settings pane an `open-settings` press opens.
   *
   * Carried on the row rather than derived at the call site, because the row
   * is where the decision "this state is fixable, and there" is made — and a
   * second mapping in the renderer is a second thing to get wrong with no test
   * looking at it.
   */
  pane: SettingsPane | null;
}

/**
 * The sentence appended to a row whose state cannot be read at all.
 *
 * Exported because both this module and its test need the exact string, and
 * because it is the one line on this screen that explains the APP's own limits
 * rather than the OS's: `tauri dev` runs a bare binary, and the framework call
 * that answers these questions aborts a process that is not an `.app` bundle.
 */
export const DEV_BUILD_NOTE = "Permissions can only be requested from the installed app.";

/** The state words, shared by both rows that have a state to report. */
function suffixFor(permission: Permission): string {
  switch (permission) {
    case "authorized":
    case "provisional":
      return "Allowed";
    case "denied":
      return "Not allowed";
    case "unavailable":
      return "Unavailable in this build";
    case "not-determined":
      return "";
  }
}

/** The glyph state for a permission whose answer is known. */
function stateFor(permission: Permission): PermissionRowState {
  switch (permission) {
    case "authorized":
    case "provisional":
      return "done";
    case "denied":
      return "failed";
    // An unasked question and an unaskable one are both "nothing has happened
    // yet" to the eye. What separates them is the suffix and the detail, not a
    // second glyph nobody could tell apart.
    case "not-determined":
    case "unavailable":
      return "pending";
  }
}

/**
 * The four rows for this machine.
 *
 * @param probe - the machine's own answers; both permission states ride on it
 * @param requesting - the notifications request is in flight right now (page
 *   state, not a probe fact — the system sheet is modal to the app, so the row
 *   has to say something is happening)
 */
export function permissionRows(probe: Probe, requesting = false): PermissionRow[] {
  const notifications = probe.notificationPermission;
  const photos = probe.photosPermission;

  // Which process will raise the Files and Folders prompt, in the name the
  // person will see on it. Under a launchd service the `readdir` runs in the
  // CLI, which is a binary they never typed — the single most malware-looking
  // prompt this product produces, and the reason this row names it at all.
  const asker = probe.supervision === "app" ? "Subshell Server" : "subshell-server";

  const notificationsDetail =
    notifications === "unavailable"
      ? `Tells you when an agent is waiting for you. ${DEV_BUILD_NOTE}`
      : "Tells you when an agent is waiting for you. Asked now, if you allow it.";

  const photosDetail =
    photos === "unavailable"
      ? `Attaching an image to an agent can read your Photos library if you pick from there. ${DEV_BUILD_NOTE}`
      : "Attaching an image to an agent can read your Photos library if you pick from there. Asked when you attach one.";

  return [
    {
      id: "notifications",
      label: "Notifications",
      detail: notificationsDetail,
      state: requesting ? "active" : stateFor(notifications),
      suffix: suffixFor(notifications),
      // The ONE prompt this app owns, and the only row that can raise one.
      action: notifications === "not-determined" ? "allow" : notifications === "denied" ? "open-settings" : null,
      pane: notifications === "denied" ? "notifications" : null,
    },
    {
      id: "files",
      label: "Files and Folders",
      detail: `The directory picker lists your home folder. macOS asks the first time you open Desktop, Documents or Downloads, and that prompt names ${asker}.`,
      // Unreadable by design: asking would mean a `readdir` of each folder
      // under home, which is the exact act that fires the prompt. So this row
      // says when, and never what.
      state: "pending",
      suffix: "Asked later",
      action: null,
      pane: null,
    },
    {
      id: "photos",
      label: "Photos",
      detail: photosDetail,
      state: stateFor(photos),
      suffix: suffixFor(photos),
      // No Allow, ever: the system asks in context, at the moment an image is
      // picked. Only the way BACK from a refusal is this screen's to offer.
      action: photos === "denied" ? "open-settings" : null,
      pane: photos === "denied" ? "photos" : null,
    },
    {
      id: "login",
      label: "Background Items",
      detail:
        "Starting at login adds Subshell Server to Login Items, and macOS shows a banner saying so. Nothing to allow.",
      state: "pending",
      suffix: "Not a permission",
      action: null,
      pane: null,
    },
  ];
}
