/**
 * What the permissions screen says (spec 2026-09-14 § 3, § 3.1).
 *
 * Three rows, ordered by what the person can DO on this screen: the two rows
 * that own a sheet it can raise come first, and the row that only explains
 * comes last (operator's ruling 2026-09-25, replacing "the order a first run
 * meets them", which put the one explanation-only row between the two
 * questions someone might press). Each question row a glyph, a label, a
 * sentence and at most one button; the explanation row carries the label, the
 * sentence and no state glyph (`info`, ruling 2026-09-25). The whole screen is
 * data here so its WORDS are testable:
 * they are the point of the feature — a person who has been told what macOS is
 * about to ask, and why, answers the sheet rather than dismissing it — and a
 * sentence that lives only inside a render is a sentence nothing ever checks.
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
 *   hand, does something wherever the pane has an entry to flip — so it is
 *   offered wherever this screen is the answer to a person's problem.
 *
 * That second half is why the `files` row carries its button ON THE RECOVERY
 * DOOR AND NOT THE FIRST-RUN ONE. The dashboard raises this screen as the fix
 * for "Blocked by macOS" on a folder it could not list (spec § 5), and that
 * row's state is UNREADABLE by construction, so a row that offered a button
 * only when denied would offer one never, and a person sent here by that
 * notice would land on lines of prose with nothing to press: the picker's
 * notice only appears once a refusal is already in the pane. A dead end at
 * the end of a Fix… button is worse than no button at all. The first-run
 * door inverts the fact, not the rule: on a machine never asked, the Files
 * and Folders pane holds no entry for this app, and a button onto an empty
 * pane is the same dead end the `photos` row's `restricted` arm refuses
 * below. The door decides, never the (unreadable) state. The door is the
 * KIND of arrival, not which notice sent the person (`PermissionDoor`):
 * notices about the other permissions route through the recovery door too,
 * and there the files pane may not yet hold a row. That is the price of a
 * door this side can answer without reading TCC, and it buys back the one
 * arrival that must never be without its button.
 */
import type { Permission, Probe, SettingsPane } from "./ipc";

/** The three rows, in the order the screen lists them: actionable rows first. */
export type PermissionRowId = "notifications" | "photos" | "files";

/**
 * A row's glyph state, borrowed from the setup checklist so "allowed" looks
 * the same everywhere this app says it. `active` is the spinner a row wears
 * while its own system sheet is up. `info` is a row with no system question
 * this screen raises: NO glyph at all, on any door (operator's ruling
 * 2026-09-25, from a live screenshot — the `files` row's empty pending ring
 * read as "a checklist item not yet done", but pending means "this row's own
 * question is unasked", and this row has no question here to tick).
 */
export type PermissionRowState = "pending" | "done" | "failed" | "active" | "info";

/** What a row's button does, or `null` when it has none. */
export type PermissionAction = "allow" | "open-settings";

/** Which of this screen's two system sheets a press raises. */
export type PermissionRequest = "notifications" | "photos";

/**
 * Which door raised this screen, and therefore whether macOS has already
 * refused something on this machine.
 *
 * `"first-run"`: the ready screen's Continue on a Mac's first run. On a
 * machine that has never been asked, the Files and Folders pane holds no
 * entry for this app, so the button would open an empty list. (macOS
 * verdicts outlive an in-app reset, which clears this app's state but not
 * TCC; anyone who resets and had denied a folder meets the notice door
 * the moment something is actually refused, and the button is there.)
 * `"recovery"`: every other arrival. The typical one is the picker's
 * "Blocked by macOS" notice, whose refusal is what puts the toggle in the
 * pane. Notices about the OTHER permissions route through here too, and
 * their arrival can leave the files pane empty; the door answers "may the
 * machine's macOS verdicts be offered as fixable", not "a files refusal
 * exists". The `files` row's Settings button (and the sentence that points
 * at it) is the only thing the answer changes; the row keeps its label,
 * suffix and explanation on either door.
 */
export type PermissionDoor = "first-run" | "recovery";

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
    // Not the person's "no": a policy, or a refusal before the question
    // could be asked. One word away from the accusation, and it is the word
    // that matches a Settings pane with no row in it.
    case "restricted":
      return "Blocked";
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
    // An unasked question and an unaskable one are both "nothing has happened
    // yet" to the eye. What separates them is the suffix and the detail, not a
    // second glyph nobody could tell apart. `restricted` wears the ✕ because
    // the act WILL fail — the ✕ is about attaching, not about blame.
    case "denied":
    case "restricted":
      return "failed";
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
 * @param door - why this screen is up, and whether macOS has already refused
 *   something. It decides only the `files` row's Settings door; the default is
 *   `"recovery"` because that is today's whole behaviour and the withholding
 *   is the exception, which the caller opts into by naming its door.
 */
export function permissionRows(
  probe: Probe,
  requesting: PermissionRequests = {},
  door: PermissionDoor = "recovery",
): PermissionRow[] {
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
      : photos === "restricted"
        ? "Attaching an image to an agent can read your Photos library if you pick from there. macOS is refusing it without asking: a profile or Screen Time restriction, or a Mac with no Photos library yet. Nothing on this screen changes that."
        : "Attaching an image to an agent can read your Photos library if you pick from there. Asked now, if you allow it, otherwise the first time you pick one.";

  // The finder hint travels with the button it describes: on the recovery door
  // there is a toggle in System Settings to flip, and pointing at it is the
  // answer; on the first-run door the pane is empty, so the sentence must not
  // gesture at it.
  const filesDetail =
    door === "recovery"
      ? `The directory picker lists your home folder. macOS asks the first time you open Desktop, Documents or Downloads, and that prompt names ${asker}, shown in System Settings with a plain generic icon.`
      : `The directory picker lists your home folder. macOS asks the first time you open Desktop, Documents or Downloads, and that prompt names ${asker}.`;

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
      id: "photos",
      label: "Photos",
      detail: photosDetail,
      state: requesting.photos ? "active" : stateFor(photos),
      suffix: suffixFor(photos),
      // The same shape as the notifications row, and the reason it is not a
      // second door to the same room is in `request_photos`'s own docblock:
      // the panel that normally raises this prompt is THIS app's image picker,
      // so a sheet raised here arms the subject the picker will hit. A refusal
      // by the PERSON has only one way back, and that stays System Settings.
      // `restricted` gets NOTHING to press: the refusal was not made on the
      // person's behalf and has no row in the pane (the 2026-09-25 VM report:
      // "Nothing in the system settings either"), and a Fix button onto an
      // empty list is the dead end this screen's own rules were built to
      // prevent. The detail sentence is the whole honest answer there is.
      action: photos === "not-determined" ? "allow" : photos === "denied" ? "open-settings" : null,
      allow: photos === "not-determined" ? { label: "Allow", request: "photos" } : null,
      pane: photos === "denied" ? "photos" : null,
    },
    {
      id: "files",
      label: "Files and Folders",
      detail: filesDetail,
      // Unreadable by design: asking would mean a `readdir` of each folder
      // under home, which is the exact act that fires the prompt. So this row
      // says when, and never what — the suffix is a moment, not a state, and
      // `info` says the same thing with the glyph: a pending ring means "this
      // row's own question is unasked, and this screen will tick it", which
      // this row can never earn — it has no question to ask from here, so it
      // could never leave pending (operator's ruling 2026-09-25).
      state: "info",
      suffix: "Asked later",
      // On the recovery door: always, precisely BECAUSE the state is
      // unreadable — this is the row the dashboard's "Blocked by macOS"
      // sends people to, and the pane it opens holds the refusal they came
      // to undo. On the first-run door: nothing to press, because macOS has
      // not been asked yet and the pane has no entry — a button there opens
      // an empty list, which is the `restricted` dead end in another row's
      // clothes. The door, not the state, decides.
      action: door === "recovery" ? "open-settings" : null,
      allow: null,
      pane: door === "recovery" ? "files-and-folders" : null,
    },
  ];
}
