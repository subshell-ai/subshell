/**
 * The server assistant's routing and poll seam, pure (spec 2026-09-21; plan
 * Task 2). `route()` is the decision `wizard.ts`'s `render()` made inline —
 * which of the window's screens the machine is asking for right now — and
 * `nextPollDelay()` is the gate `tick()` made inline — whether the 1500 ms
 * poll runs at all. Both are functions of the state the host holds, so the
 * React host renders from them instead of mutating a page.
 *
 * Everything this file reads comes from `wizard-state` and `ipc`, unchanged:
 * the routing is a PORT of the old dispatch, word for word in its branches,
 * and a branch that was dropped is a behavior regression the tests beside it
 * pin.
 */
import type { RailSection } from "@internal/assistant";
import type { ActionResult, Probe } from "./ipc";
import { isRequestedScreen, type ScreenId, screensFor } from "./wizard-state";

/** The poll's cadence, unchanged from `wizard.ts`. */
export const POLL_MS = 1500;

/**
 * Which screen the window shows, as one of the kinds the host's switch maps
 * to components. The names are the screens' own, with three renames the
 * reference map fixed long before this port:
 *
 * - `status` is BOTH the recovery screen and the ready handoff's open-
 *   dashboard half — they render the same diagnosis-or-running surface and
 *   the reference map sends them to one component;
 * - `setup` covers the setup screen AND the progress checklist, which shows
 *   while `running` (the host does not need a second kind for a screen that
 *   is the first one, busy);
 * - `addresses` is the `settings` wire word — Server Addresses keeps its own
 *   name off the wire, as it always has.
 *
 * `boot` is "no probe yet": the frame's wordmark and one sentence.
 */
export type Route =
  | { kind: "welcome" }
  | { kind: "tmux" }
  | { kind: "setup" }
  | { kind: "handoff" }
  | { kind: "status" }
  | { kind: "update" }
  | { kind: "supervision" }
  | { kind: "addresses" }
  | { kind: "permissions" }
  | { kind: "reset" }
  | { kind: "boot" };

/**
 * Which screen the window shows for THIS state, in the old render()'s exact
 * order:
 *
 * 1. the reset screen — `openReset` sets `screen` before it arms the plan,
 *    and the old render's reset gate ran before everything below, because
 *    the screen is what explains a refusal and must show with or without a
 *    probe;
 * 2. `boot` while the probe is still landing — nothing that reads a probe
 *    may render before the first one answers, which is what the old
 *    render's `probe === null` arm protected;
 * 3. a REQUESTED screen outranks both families — the SPA deep-links Update
 *    onto a running server and Reset onto its danger card, the tray opens
 *    the update screen, and the ready handoff below would otherwise send the
 *    window straight back to the dashboard it was just asked to leave;
 * 4. an empty `screensFor` list means ready: the progress checklist while
 *    the chain runs (the poll ticks precisely because `running` is set — the
 *    port binds before the chain's finally records its end), otherwise the
 *    ready handoff. Which arm the handoff takes — wait for a Continue or
 *    open the dashboard — is `handoffView`'s answer, the screen's business,
 *    not the route's;
 * 5. otherwise resolve `screen` against the list, and correct one the probe
 *    no longer offers: null resolves to the list's head, and a stale screen
 *    walks to `(list[0] === "welcome" ? list[1] : list[0])` — THE tmux
 *    advance, which skips the greeting the reader already pressed past, and
 *    the same correction that lands a freshly-onboarded machine on recovery.
 *
 * `failure` is in the shape the host passes — it steers the setup screen's
 * failure variant inside the component, exactly as `renderSetup` checked it
 * — but the route is the same either way: the routing never branched on it.
 */
export function route(
  probe: Probe | null,
  screen: ScreenId | null,
  s: { running: boolean; failure: ActionResult | null },
): Route {
  if (screen === "reset") return { kind: "reset" };
  if (probe === null) return { kind: "boot" };
  if (isRequestedScreen(screen)) {
    if (screen === "update") return { kind: "update" };
    if (screen === "supervision") return { kind: "supervision" };
    if (screen === "settings") return { kind: "addresses" };
    if (screen === "permissions") return { kind: "permissions" };
  }
  const resolved = resolveJourney(probe, screen);
  if (resolved === null) {
    if (s.running) return { kind: "setup" };
    return { kind: "handoff" };
  }
  // `resolved` is one of the four by construction — `list` only ever holds
  // those — and the fallback exists so a family added later is the screen
  // that diagnoses rather than a blank window on a machine someone is
  // repairing.
  if (resolved === "welcome") return { kind: "welcome" };
  if (resolved === "tmux") return { kind: "tmux" };
  if (resolved === "setup") return { kind: "setup" };
  return { kind: "status" };
}

/**
 * The journey screen the old `render()` resolved and corrected `screen` to,
 * or `null` when the list is empty (the ready handoff's territory).
 *
 * `route()` renders from this; the host ALSO writes it back — the old render
 * overwrote its module `screen` with the resolution, so a corrected screen
 * stayed corrected, and without that write-back a screen that re-enters the
 * list later (tmux disappearing again) would flip the window back to a
 * screen the person already left. The correction branch only:
 *
 * - a null screen keeps meaning "whatever the probe implies" and is
 *   re-derived here every time;
 * - a screen still offered is returned as-is;
 * - a screen the probe no longer offers walks to
 *   `(list[0] === "welcome" ? list[1] : list[0])` — THE tmux advance, which
 *   skips the greeting the reader already pressed past, and the same
 *   correction that lands a freshly-onboarded machine on recovery.
 */
export function resolveJourney(probe: Probe, screen: ScreenId | null): ScreenId | null {
  const list = screensFor(probe, probe.onboarded);
  if (list.length === 0) return null;
  if (screen === null) return list[0] ?? "setup";
  if (!list.includes(screen)) return (list[0] === "welcome" ? list[1] : list[0]) ?? "setup";
  return screen;
}

/**
 * Whether the poll runs, and at what cadence — the gate `tick()` checked at
 * its top, as data.
 *
 * A poll must NOT run while an action is in flight (a refresh under a
 * running action is what it exists to avoid) nor while the window is hidden
 * (the console's own rule about its hidden window) — with the one exception
 * the old guard carried: the setup chain. `running` is what the poll ticks
 * FOR, since the progress checklist reads the probe, so it outranks both
 * holds.
 *
 * Returns `null` when the host must not schedule a poll at all, and
 * {@link POLL_MS} when it must.
 */
export function nextPollDelay(s: { busy: boolean; running: boolean; hidden: boolean }): number | null {
  if ((s.busy || s.hidden) && !s.running) return null;
  return POLL_MS;
}

/**
 * The rail's standing sections, in display order (spec 2026-09-21; plan Task
 * 10, Reset joined by the operator's 2026-09-22 ruling). Five, and the labels
 * are the section's own copy — the Rail primitive renders no strings of its
 * own. The ids are the wire words they route to, with Status the one
 * exception: the recovery screen has no requested id, so its section routes
 * to `recovery`, which the journey resolves back onto the diagnosis.
 */
export const RAIL_SECTIONS: RailSection[] = [
  { id: "status", label: "Status" },
  { id: "update", label: "Update" },
  { id: "supervision", label: "Service" },
  { id: "settings", label: "Addresses" },
  // The fifth section is the DESTRUCTIVE one (operator ruling 2026-09-22,
  // live screenshot): the DOOR moves into the rail, styled in the destructive
  // token. Since the same day's LAYOUT ruling (final word) the confirmation
  // rides the rail too, reset active — the frame-replacing premise moved to
  // the RUNNING chain, which host.tsx enforces by withholding the rail from
  // the render for `busy || running`.
  { id: "reset", label: "Reset", danger: true },
];

/**
 * Whether THIS route gets the rail, and which sections it shows.
 *
 * The rule is the spec's sentence (2026-09-21, with the operator's 2026-09-22
 * ruling on the FTE): **the rail appears when the machine is onboarded and no
 * first-run step is in progress.** So the FTE family (welcome, tmux, setup,
 * handoff), the permissions screen and boot answer null — full-window, no
 * rail. Reset's CONFIRMATION rides the rail (the 2026-09-22 layout ruling
 * superseded its frame-replacing premise; the room is the running chain,
 * which host.tsx enforces off `busy || running`), and a STANDING route on a machine
 * that
 * is not onboarded answers null too: the old page let a requested update
 * render mid-first-run, and wave 2 keeps the render but takes away the rail,
 * because the exclusion is about the machine's journey, not about who asked.
 *
 * The active section is not folded in here — a `RailSection` is `{id, label}`
 * by design, and the active state is the Rail primitive's prop — so
 * {@link railActive} answers it, keyed on the same route.
 */
export function railFor(r: Route, onboarded: boolean): RailSection[] | null {
  if (!onboarded) return null;
  switch (r.kind) {
    case "status":
    case "update":
    case "supervision":
    case "addresses":
    // The reset CONFIRMATION rides the rail now (operator ruling 2026-09-22,
    // final word on the reset layout, superseding the frame-replacing
    // premise for the confirmation): the sidebar stays, reset active and
    // danger-styled. The room is the RUNNING chain — host.tsx withholds the
    // rail from the render while the chain runs, which is where the safety
    // property lives now.
    case "reset":
      return RAIL_SECTIONS;
    default:
      return null;
  }
}

/** The rail section THIS standing route has active, or null when there is no rail. */
export function railActive(r: Route): string | null {
  switch (r.kind) {
    case "status":
      return "status";
    case "update":
      return "update";
    case "supervision":
      return "supervision";
    case "addresses":
      return "settings";
    // The reset confirmation rides the rail (2026-09-22 layout ruling).
    case "reset":
      return "reset";
    default:
      return null;
  }
}
