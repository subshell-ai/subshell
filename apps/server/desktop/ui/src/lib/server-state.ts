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
import type { ActionResult, Probe } from "./ipc";
import { isRequestedScreen, screensFor } from "./wizard-state";

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
  screen: ScreenIdLike,
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
  const list = screensFor(probe, probe.onboarded);
  if (list.length === 0) {
    if (s.running) return { kind: "setup" };
    return { kind: "handoff" };
  }
  let resolved: string;
  if (screen === null) {
    resolved = list[0] ?? "setup";
  } else if (!list.includes(screen)) {
    resolved = (list[0] === "welcome" ? list[1] : list[0]) ?? "setup";
  } else {
    resolved = screen;
  }
  // `screen` is one of the four by construction — `list` only ever holds
  // those — and the fallback exists so a family added later is the screen
  // that diagnoses rather than a blank window on a machine someone is
  // repairing.
  if (resolved === "welcome") return { kind: "welcome" };
  if (resolved === "tmux") return { kind: "tmux" };
  if (resolved === "setup") return { kind: "setup" };
  return { kind: "status" };
}

/** `ScreenId | null` — typed here so `route()` needs no import of its own. */
type ScreenIdLike = Parameters<typeof isRequestedScreen>[0];

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
