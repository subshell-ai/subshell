/**
 * What the permissions screen says (spec 2026-09-14 § 3, § 3.1).
 *
 * Three rows, in the order a first run meets them, each one a glyph, a label, a
 * sentence and at most one button. The whole screen is data here so its WORDS
 * are testable: they are the point of the feature — a person who has been told
 * what macOS is about to ask, and why, answers the sheet rather than dismissing
 * it — and a sentence that lives only inside a render is a sentence nothing
 * ever checks.
 *
 * The fourth row this screen shipped with — Background Items — is gone
 * (operator's request, 2026-09-17). It explained the "Background Items Added"
 * banner, which is real, but it is not a permission, has no state, no pane and
 * nothing to press, and a row that can never change is not information: it was
 * one line of prose standing where a person looks for decisions.
 *
 * Two rules run through all of it:
 *
 * - **Nothing here blocks.** Declining is a legitimate answer, so no row gates
 *   Continue and no row nags. The screen prepares; the recovery path (a denied
 *   row's Open Settings, reachable forever afterwards) is what exists
 *   for changing your mind.
 * - **A button is offered only where pressing it does something** — which is
 *   not the same as "only where a state is bad". macOS asks once, so "Allow"
 *   appears only while the state is `not-determined`: anything else there is a
 *   control that silently no-ops, which teaches people that this screen's
 *   controls are decoration. Opening a System Settings pane, on the other
 *   hand, ALWAYS does something — the pane is there whether or not the
 *   question has been asked — so it is offered wherever this screen is the
 *   answer to a person's problem.
 *
 * That second half is why the `files` row carries a button in every state. The
 * dashboard raises this screen as the fix for "Blocked by macOS" on a folder
 * it could not list (spec § 5), and that row's state is UNREADABLE by
 * construction — so a row that offered a button only when denied would offer
 * one never, and a person sent here by the notice would land on lines of prose
 * with nothing to press. A dead end at the end of a Fix… button is
 * worse than no button at all.
 */
import type { Permission, Probe, SettingsPane } from "./ipc";

/** The three rows, by the moment they arrive rather than by severity. */
export type PermissionRowId = "notifications" | "files" | "photos";

/**
 * A row's glyph state, borrowed from the setup checklist so "allowed" looks
 * the same everywhere this app says it. `active` is the spinner a row wears
 * while its own system sheet is up.
 */
export type PermissionRowState = "pending" | "done" | "failed" | "active";

/** What a row's button does, or `null` when it has none. */
export type PermissionAction = "allow" | "open-settings";

/** Which of this screen's two system sheets a press raises. */
export type PermissionRequest = "notifications" | "photos";

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
   * What the row's `allow` button SAYS and which sheet it raises, or `null`
   * when the row has no ask to offer.
   *
   * One field carrying both, because the renderer used to hardcode both — the
   * label "Allow notifications" and the `allowNotifications` handler — at the
   * time when that was the only row that could ask anything. With Photos
   * asking too, a hardcoded label puts one permission's name on a button that
   * spends the other's question, and a dispatch on `id` would route an
   * unlisted third row to notifications in silence. The LABEL is now the bare
   * "Allow" (operator's call, 2026-09-25: the row's own label names the
   * permission, and the long buttons read as clutter), so what carries the
   * anti-mis-wiring is the REQUEST: still paired here, and the renderer's
   * `Record<PermissionRequest, …>` fails to COMPILE with a request that has no
   * handler.
   *
   * Present exactly where `action` is `"allow"` — pinned by test, so the
   * renderer's guard is a guard and not a second decision.
   */
  allow: { label: string; request: PermissionRequest } | null;
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
 * Which of this screen's two requests is in flight right now.
 *
 * Page state, not a probe fact: each system sheet is modal to the app and the
 * answer only reaches the probe on a later tick, so the row has to say
 * something is happening. An object rather than two positional flags because
 * two same-typed booleans in a row are a call site that reads
 * `permissionRows(p, true, false)` and a mistake nothing can see.
 */
export interface PermissionRequests {
  /** The notifications sheet is up. */
  notifications?: boolean;
  /** The Photos sheet is up. */
  photos?: boolean;
}

/**
 * The three rows for this machine.
 *
 * @param probe - the machine's own answers; both permission states ride on it
 * @param requesting - which request this screen raised a moment ago
 */
export function permissionRows(probe: Probe, requesting: PermissionRequests = {}): PermissionRow[] {
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
      : "Attaching an image to an agent can read your Photos library if you pick from there. Asked now, if you allow it, otherwise the first time you pick one.";

  return [
    {
      id: "notifications",
      label: "Notifications",
      detail: notificationsDetail,
      state: requesting.notifications ? "active" : stateFor(notifications),
      suffix: suffixFor(notifications),
      // One of the TWO prompts this app owns. Both rows can raise their own
      // sheet, and each carries its own `request` — see `allow`.
      action: notifications === "not-determined" ? "allow" : notifications === "denied" ? "open-settings" : null,
      allow: notifications === "not-determined" ? { label: "Allow", request: "notifications" } : null,
      pane: notifications === "denied" ? "notifications" : null,
    },
    {
      id: "files",
      label: "Files and Folders",
      detail: `The directory picker lists your home folder. macOS asks the first time you open Desktop, Documents or Downloads, and that prompt names ${asker}.`,
      // Unreadable by design: asking would mean a `readdir` of each folder
      // under home, which is the exact act that fires the prompt. So this row
      // says when, and never what — the suffix is a moment, not a state.
      state: "pending",
      suffix: "Asked later",
      // Always, precisely BECAUSE the state is unreadable: this is the row the
      // dashboard's "Blocked by macOS" sends people to, and the pane it opens
      // is where a refusal is undone whether or not macOS has asked yet.
      action: "open-settings",
      allow: null,
      pane: "files-and-folders",
    },
    {
      id: "photos",
      label: "Photos",
      detail: photosDetail,
      state: requesting.photos ? "active" : stateFor(photos),
      suffix: suffixFor(photos),
      // The same shape as the notifications row, and the reason it is not a
      // second door to the same room is in `request_photos`'s own docblock:
      // the panel that normally raises this prompt is THIS app's image picker,
      // so a sheet raised here arms the subject the picker will hit. A refusal
      // still has only one way back, and that stays System Settings.
      action: photos === "not-determined" ? "allow" : photos === "denied" ? "open-settings" : null,
      allow: photos === "not-determined" ? { label: "Allow", request: "photos" } : null,
      pane: photos === "denied" ? "photos" : null,
    },
  ];
}
