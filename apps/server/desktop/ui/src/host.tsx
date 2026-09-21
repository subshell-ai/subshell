/**
 * The assistant's HOST — the React replacement for `wizard.ts`'s page-level
 * machinery (spec 2026-09-21; plan Task 2).
 *
 * The old page was one module of mutable vars plus an imperative `render()`.
 * This file is its value-for-value port: every module var is a `useState`
 * here, `render()` is React reconciliation, and the boot sequence, the event
 * listeners and the 1500 ms poll run as effects in the same order the old
 * module evaluated them (boot probe → `desktop_pending_screen` pull → event
 * listeners; the poll's interval started after the first render, before the
 * `about` read).
 *
 * What it does NOT do yet: render screens. Tasks 3–7 port `wizard.ts`'s
 * render functions into components under `screens/`, and Task 8 deletes the
 * old page and wires `main.tsx`. Until then the content region is an empty,
 * marked placeholder and the route is computed but not dispatched.
 *
 * The IPC boundary is untouched: the same commands, the same events, the
 * same order. `lib/` is untouched: `route()` and `nextPollDelay()` (the pure
 * seams this host renders from) live in `lib/server-state.ts`.
 *
 * **Six module vars the old page held are NOT here, on purpose** — they are
 * screen-local in the React model, because a component that persists across
 * re-renders no longer needs page-level state to survive the poll's DOM
 * teardown. Each is recorded with its home so Tasks 3–7 cannot drop it:
 *
 * - `tmuxOutputOpen`, `tmuxOutputScroll` (wizard.ts:165/177, written at
 *   561/655/666/672) — the tmux screen's failure-output disclosure →
 *   **TmuxScreen**;
 * - `manualRoute` (wizard.ts:193, 815–825) — which manager's manual
 *   instructions the tmux screen shows → **TmuxScreen**;
 * - `requestingNotifications` / `requestingPhotos` (wizard.ts:253–254,
 *   written at 1915/1939) — the permission sheets' in-flight flags →
 *   **PermissionsScreen**;
 * - `installClock` + `startInstallClock`/`stopInstallClock` (wizard.ts:505)
 *   — the 1 s repaint that keeps the tmux install's clock moving while
 *   `busy` holds the poll off → the setup chain's **TmuxScreen** act (Task 3).
 *
 * `_checkPort` here is inline in Host for now; Task 6 lifts it into the
 * `usePortCheck` hook the plan names, when the first consumer (the address
 * form) exists.
 */

import { Frame } from "@internal/assistant";
import { listen } from "@tauri-apps/api/event";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type AddressForm, type ExplicitMap, effectiveForm, type FormValues } from "./lib/config-form";
import type { About, ActionResult, AppUpdateCheck, LogTail, Probe } from "./lib/ipc";
import * as ipc from "./lib/ipc";
import { nextPollDelay, resolveJourney, route } from "./lib/server-state";
import { type ActState, NO_SELECTION, type UpdateActSelection } from "./lib/update-act";
import {
  DEFAULT_SUPERVISION,
  handoffView,
  isRequestedScreen,
  type ScreenId,
  type SupervisionChoice,
  screenForRequest,
  screensFor,
} from "./lib/wizard-state";

/**
 * A rejected command's words, for the problem line.
 *
 * Copied from `assistant/host.ts`, which the port DELETES in Task 8 — this
 * is the one helper the host still needs from it, and the copy dies with
 * that deletion rather than keeping a DOM-helpers module alive for it.
 */
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * What a screen may ask the host for — the old `AssistantHost` shape, plus
 * `go`. It reaches a screen through {@link HostActionsContext}; the action
 * runners each screen owns (the setup chain, the tmux install, the update
 * act) join this interface in the tasks that port them, so the object grows
 * with its consumers instead of being invented all at once.
 *
 * There is no `render()` member. The old page needed one because the DOM was
 * imperative; a React screen re-renders when the state it writes changes,
 * and a host a screen could ask to repaint would be inviting it to think in
 * the old model.
 */
export interface HostActions {
  /** The latest probe, or null before the first one lands. */
  probe(): Probe | null;
  /** Whether an action is in flight. Every screen disables its controls on it. */
  busy(): boolean;
  setBusy(on: boolean): void;
  /** Re-read the machine. */
  refresh(): Promise<void>;
  /** Record a rejection's words as the page's problem line. */
  fail(err: unknown): void;
  /** Leave a requested screen (reset, update) for whatever the probe implies. */
  close(): void;
  /**
   * Forget the page-scoped one-shot flags a wipe invalidates: the fired-this-
   * load latch and the last setup-chain failure. Called when a reset CHAIN
   * completes, never on cancel.
   */
  rearmFirstRun(): void;
  /** Navigate to a screen the user asked for (the old `go`). */
  go(to: ScreenId): void;
}

const HostActionsContext = createContext<HostActions | null>(null);

/** The context a screen reads its host through. */
export const useHostActions = (): HostActions => {
  const actions = useContext(HostActionsContext);
  if (actions === null) throw new Error("a screen rendered outside the assistant host");
  return actions;
};

/**
 * Whether the window is hidden, as state.
 *
 * The old `tick()` read `document.hidden` live at every tick; a hook is the
 * same fact for a render, and the `visibilitychange` listener is what makes
 * the poll's gate re-evaluate when it changes.
 */
function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return hidden;
}

export function Host(): React.JSX.Element {
  // ---------------------------------------------------------------------------
  // State. Every var the old module held, as its own hook, ported
  // value-for-value — including the ones whose WRITERS are still imperative
  // code that Tasks 3–7 port.
  // ---------------------------------------------------------------------------

  /** The latest probe, or null before the first one lands. */
  const [probe, setProbe] = useState<Probe | null>(null);
  /**
   * The screen showing, or `null` for "whatever the probe implies".
   *
   * `null` is what a requested screen is dismissed BACK to, and what the
   * first probe resolves; it is not a fourth state to render.
   */
  const [screen, setScreen] = useState<ScreenId | null>(null);
  /** A one-off act (tmux install, pick a binary) is in flight. */
  const [busy, setBusyState] = useState(false);
  /** The setup chain is running. The poll must not stop for that. */
  const [running, _setRunning] = useState(false);
  /** The chain's last answer when it stopped short; cleared by Try Again. */
  const [failure, setFailure] = useState<ActionResult | null>(null);
  /** True once this page has asked for the dashboard. Never twice. */
  const [opened, setOpened] = useState(false);
  /** The dashboard refused to open, so stop retrying and let the human press something. */
  const [_openFailed, setOpenFailed] = useState(false);
  const [problem, setProblem] = useState("");
  const [_customizeOpen, _setCustomizeOpen] = useState(false);
  /** The last action's own words, for the recovery screen's Show Details. */
  const [_lastResult, _setLastResult] = useState<ActionResult | null>(null);
  /**
   * The tmux install's own progress: the manager's last output line, and when
   * the install began (`0` = none running, the old sentinel).
   */
  const [_installLine, setInstallLine] = useState("");
  const [installStartedAt, _setInstallStartedAt] = useState(0);
  /**
   * The tmux install's own last answer, or `null` when none has run in this
   * window.
   *
   * Its OWN slot rather than `lastResult`, which every `act` overwrites: the
   * failure block is a verdict on the tmux install specifically, and a result
   * left by some other press rendering under "The tmux install didn't finish."
   * would be this screen inventing a failure out of another screen's words.
   * Cleared by the next press and by a tmux that appears.
   */
  const [_tmuxResult, _setTmuxResult] = useState<ActionResult | null>(null);
  /** The last log tail, refreshed on the poll only while the disclosure is open. */
  const [_lastTail, setLastTail] = useState<LogTail | null>(null);
  /**
   * Whether Show Details is expanded.
   *
   * Page state rather than the element's, because the old page rebuilt
   * `#content` on every render; a controlled disclosure holds its own state
   * here for the same reason — the poll must not be able to collapse it under
   * the reader.
   */
  const [detailsOpen, _setDetailsOpen] = useState(false);
  /** True while the ready handoff is on screen, so its entrance replays once. */
  const [handedOff, setHandedOff] = useState(false);
  /**
   * The setup chain has fired itself once in THIS window load. One fire per
   * load; a completed RESET clears it through `rearmFirstRun`.
   */
  const [_autoFired, setAutoFired] = useState(false);
  /**
   * The setup chain ran to completion in THIS window, so the ready screen
   * owes the person its result rather than vanishing into the dashboard.
   * Page state on purpose: `probe.onboarded` cannot answer it, since the
   * probe sets that flag on the very first `ready` it sees.
   */
  const [ranSetupHere, _setRanSetupHere] = useState(false);
  /**
   * That chain was a FIRST RUN — the machine was not onboarded when it
   * started. Captured at the press rather than read at the handoff, because
   * by then the probe has already flagged `onboarded`. See
   * `permissionsAfterSetup`, its one consumer.
   */
  const [_ranFirstRunHere, _setRanFirstRunHere] = useState(false);
  /** They pressed Continue on that screen. */
  const [continued, _setContinued] = useState(false);
  /**
   * The ready screen's Continue sent them to the permissions screen, so its
   * own press is a Continue that opens the dashboard rather than a Back that
   * drops them where the probe implies.
   */
  const [_permissionsAfterHandoff, setPermissionsAfterHandoff] = useState(false);
  /** The two supervision boxes on the setup screen; reset with the form. */
  const [_supervision, _setSupervision] = useState<SupervisionChoice>(DEFAULT_SUPERVISION);
  /**
   * The supervision screen's own pending choice, held across renders because
   * a radio read from the probe alone would undo the person's selection
   * before they reached Apply. Cleared when the screen is left, so it always
   * opens showing the machine's real state.
   */
  const [_supervisionForm, setSupervisionForm] = useState<SupervisionChoice | null>(null);
  /**
   * The **Server Addresses** screen's own form, seeded on its first render of
   * a visit and cleared when the screen is left. `null` means "not seeded for
   * this visit". Separate from the setup screen's `form`/`explicit`
   * deliberately: a half-typed port left behind on one screen is not an
   * answer the other should show.
   */
  const [_settingsForm, setSettingsForm] = useState<AddressForm | null>(null);
  /**
   * Whether the person chose to configure Server Addresses without a reading
   * of the machine (review, 2026-09-18). Cleared with {@link settingsForm},
   * because it is a decision about THIS visit.
   */
  const [_settingsBlind, setSettingsBlind] = useState(false);
  /**
   * That screen's Force box, once touched; `null` is untouched, and untouched
   * means unticked — an override that arrives pre-accepted is not an override.
   */
  const [_settingsForceChecked, setSettingsForceChecked] = useState<boolean | null>(null);
  /** That screen's own last Save or Restart, so it renders nobody else's words. */
  const [_settingsResult, setSettingsResult] = useState<ActionResult | null>(null);
  /**
   * Whether the SETUP screen's address form has seeded itself once.
   *
   * That form opens and closes under the Customize link while the page stays
   * loaded, so it seeds on its first render and KEEPS what was typed across
   * renders; only `resetForm()` — the Customize disclosure collapsing —
   * clears it. Server Addresses shares the four fields but seeds fresh on
   * every visit; that screen's clearing is its own settings-form reset,
   * which `applyScreen` and `close` perform.
   */
  const [_seeded, _setSeeded] = useState(false);
  /**
   * The update screen's release answer, which is a NETWORK read and therefore
   * not on the 1500 ms poll. The check runs on the screen's first render and
   * on Check Again, and its answer lives here across the renders in between.
   */
  const [_appUpdate, _setAppUpdate] = useState<AppUpdateCheck | null>(null);
  /** What the update screen is doing; the machine's half rides the probe. */
  const [_updateState, _setUpdateState] = useState<ActState>("idle");
  /** The download's own last line, from the plugin's progress events. */
  const [_updateProgress, setUpdateProgress] = useState("");
  /**
   * The update act's last answer in THIS window — the install, or the restart
   * behind it. Page state, for the reason `ranSetupHere` is: a successful
   * bundled install CLEARS the marker the probe reports, so a screen reading
   * the probe alone would forget what it had just done between one poll and
   * the next.
   */
  const [_updateResult, setUpdateResult] = useState<ActionResult | null>(null);
  /**
   * The second half of an update has been fired in THIS window load. One fire
   * per load, exactly like `autoFired`; what bounds RETRIES is the marker's
   * own attempt count, not this.
   */
  const [_resumeFired, setResumeFired] = useState(false);
  /**
   * What the person has ticked on the update screen. Held as OVERRIDES rather
   * than as the answer: an absent row id means untouched, so the model's
   * default follows the machine as the probe changes.
   */
  const [_updateSelection, setUpdateSelection] = useState<UpdateActSelection>(NO_SELECTION);
  /**
   * The setup screen's address form and its touched-fields map. `effectiveForm`
   * with no status is the old module's own initial value — the four fields
   * start empty and the machine's stored settings answer the checklist until
   * the form renders.
   */
  const [_form, _setForm] = useState<FormValues>(() => effectiveForm(undefined));
  const [_explicit, _setExplicit] = useState<ExplicitMap>({});
  /** Who made this app, its version and its terms — read ONCE on boot. */
  const [_about, setAbout] = useState<About | null>(null);
  /**
   * The reset chain's most recent step event, as the listener delivers it.
   * The reset screen's meter consumes it (Task 7); the host is its writer
   * because the event arrives whether or not the screen is up.
   */
  const [_resetStep, setResetStep] = useState<{ step: string; state: string } | null>(null);
  /** True once the boot sequence has run to the point the old page started its poll. */
  const [booted, setBooted] = useState(false);

  // ---------------------------------------------------------------------------
  // The port check. `checkPort`'s superseded-answer drop, as a hook.
  // ---------------------------------------------------------------------------

  /**
   * The last port this page asked about, and the answer for it.
   *
   * Not a probe field: the probe reports the MACHINE, and this reports a
   * number the person may be typing into the address form, which changes
   * without the machine changing. Keyed by the port so an answer is only ever
   * read back for the port it was measured on.
   */
  const [portCheck, setPortCheck] = useState<{ port: string; inUse: boolean } | null>(null);
  /**
   * The port the newest check was fired for.
   *
   * It does two jobs: one render's question is asked once, and an answer that
   * arrives after a newer check was fired is DROPPED — two loopback connects
   * race, and the slower one is the older question. A ref rather than state:
   * it is a guard on in-flight answers, never something to render.
   */
  const portAsked = useRef<string | null>(null);

  /**
   * Ask about one port, unless that answer is already in hand or on its way.
   *
   * The old page's "never redraw under a hand typing" gate is gone
   * structurally: a React re-render is reconciliation, and controlled inputs
   * keep their text and cursor, so the answer can land whenever it arrives.
   * The superseded-answer drop above is the part that was ABOUT the answers,
   * and it is preserved exactly.
   */
  const _checkPort = useCallback(
    (port: string): void => {
      if (portCheck?.port === port || portAsked.current === port) return;
      const numeric = Number(port);
      // A port that is not a port is the CLI's refusal to make, not this
      // check's: `u16` would reject the invoke outright, and the config form
      // already shows the server's own complaint about the value. Cached as
      // free so the gate opens and the chain gets to report what is actually
      // wrong.
      if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
        setPortCheck({ port, inUse: false });
        return;
      }
      portAsked.current = port;
      const asked = ipc.portInUse(numeric);
      asked
        // A refused command is not a busy port. The page has no way to tell
        // them apart and only one of them is safe to assume, so a failed
        // check reads as free and the chain reports the bind failure itself.
        .catch(() => ({ inUse: false }))
        .then(({ inUse }) => {
          // Superseded: the field moved on while this was in flight, and the
          // answer is about a port nothing is asking about.
          if (portAsked.current !== port) return;
          setPortCheck({ port, inUse });
        });
    },
    [portCheck],
  );

  // ---------------------------------------------------------------------------
  // Host actions. The old `AssistantHost`, as React state writes.
  // ---------------------------------------------------------------------------

  /**
   * Re-read the machine. The old `refresh` put `probe.error` over the problem
   * line when the probe carried one and left the line alone when it did not —
   * a re-probe must never be able to CLEAR the message an action just
   * produced, only to replace it with a machine's own error.
   */
  const refresh = useCallback(async (): Promise<void> => {
    const next = await ipc.probe();
    setProbe(next);
    setProblem((prev) => next.error ?? prev);
  }, []);

  const fail = useCallback((err: unknown): void => {
    setProblem(errText(err));
  }, []);

  const go = useCallback((to: ScreenId): void => {
    setScreen(to);
  }, []);

  const setBusy = useCallback((on: boolean): void => {
    setBusyState(on);
  }, []);

  /**
   * Leave a requested screen for whatever the probe implies — the old
   * `host.close()`, whose writes are the one-visit state a second visit must
   * not inherit: a pending supervision choice, the address form and its Force
   * box (whose fields are PREFILLED from the machine, so a stale draft would
   * read as the configuration), and its result.
   */
  const close = useCallback((): void => {
    setResetStep(null); // the old `resetView.hide()`
    setSupervisionForm(null);
    setSettingsForm(null);
    setSettingsBlind(false);
    setSettingsForceChecked(null);
    setSettingsResult(null);
    setScreen(null);
  }, []);

  /**
   * Forget the page-scoped one-shot flags a wipe invalidates: the fired-this-
   * load latch and the last setup-chain failure. `failure` goes with
   * `autoFired` because both describe the PRE-reset chain — a first run that
   * failed at `service install`, got reset instead, and then met the old
   * failure screen under a brand-new welcome would be a ghost.
   */
  const rearmFirstRun = useCallback((): void => {
    setAutoFired(false);
    setFailure(null);
  }, []);

  /**
   * Apply a screen named from OUTSIDE this page, from either source.
   *
   * One function because there are two ways in and they must not drift: a
   * LIVE window is told by `desktop-screen`, and a window that is still
   * coming up ASKS on boot (`ipc.pendingScreen`). The asking is not a nicety
   * — the push it replaced was emitted from Rust's `on_page_load`, which
   * fires before this page's JavaScript exists.
   */
  const applyScreen = useCallback((payload: string): void => {
    if (payload === "reset") {
      // The old `openReset` set `screen` first, then armed the plan — the
      // screen is what explains a refusal, so it shows whether or not a plan
      // staged. Arming is the reset screen's own act (Task 7); the routing
      // is already exact.
      setScreen("reset");
      return;
    }
    setResetStep(null); // the old `resetView.hide()`
    // A pending selection belongs to one visit of the supervision screen, and
    // this is its other exit: the sidebar pill, an Update request or a Reset
    // request all land here while that screen may be showing.
    setSupervisionForm(null);
    // Server Addresses has the same two exits and the same rule: its fields
    // are seeded from the machine, so a draft surviving into the next visit
    // would be showing a configuration the machine may no longer have.
    setSettingsForm(null);
    setSettingsBlind(false);
    setSettingsForceChecked(null);
    setSettingsResult(null);
    // `seeded` is deliberately NOT here: it is the SETUP form's seeded-once
    // flag, cleared only by that form's reset, and the old `applyScreen`
    // never touched it.
    // Same rule for the update act: its result and its fired-once latch
    // belong to ONE visit. Without this a window that finished an update and
    // came back would render "up to date" from a page fact rather than from
    // the machine — and, worse, a phase 2 that FAILED would come back to a
    // screen with the latch still set: no auto-fire, and no Try Again either,
    // because the button hangs off the result this would otherwise have kept.
    setUpdateResult(null);
    setResumeFired(false);
    // The ticks belong to one visit too: a selection made against the machine
    // as it was is not an answer about the machine as it is now.
    setUpdateSelection(NO_SELECTION);
    // A REQUESTED permissions screen is not the handoff's, whatever this
    // window was doing a moment ago: it was asked for from somewhere the
    // person can go back to, so it takes Back rather than the Continue that
    // opens a dashboard.
    setPermissionsAfterHandoff(false);
    setScreen(screenForRequest(payload));
    // A reset returns this page to a machine with nothing set up, so the
    // handoff guard has to be released or a later ready probe renders nothing.
    setHandedOff(false);
  }, []);

  // ---------------------------------------------------------------------------
  // Boot, in the old module's exact order.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    // HMR during development loads the page twice on edit; both reads below
    // are reads, so a remount is idempotent (spec 2026-09-21 § Risks).
    let alive = true;
    void (async () => {
      // PROBE FIRST, then the screen request, then the first render.
      //
      // The screen request cannot come first, though it did until the comment
      // below was written: `applyScreen("reset")` shows the reset screen
      // SYNCHRONOUSLY, and a reset screen drawn against `probe === null`
      // renders the "does not report its data locations" refusal with its
      // button disabled, for the length of one CLI probe. A false and
      // frightening sentence, on the one screen where being trusted matters
      // most.
      try {
        await refresh();
      } catch (err) {
        setProblem(errText(err));
      }
      if (!alive) return;
      // What this window was opened FOR. After the probe so the screen it
      // raises has facts to draw; before the first render so that render is
      // already the right screen rather than a flash of the wrong one.
      try {
        const requested = await ipc.pendingScreen();
        if (requested && alive) applyScreen(requested);
      } catch {
        // An older Rust half knows no such command. Nothing was requested
        // that this page can honour, and the probe above already brought it
        // up.
      }
      if (!alive) return;
      // The old page started its poll HERE — after the first render, before
      // the `about` read. Nothing on screen waits for that read, and a failed
      // read must not stop the page from coming up on the machine it exists
      // to repair.
      setBooted(true);
      try {
        const read = await ipc.about();
        if (alive) setAbout(read);
      } catch {
        /* the disclosure omits the block */
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh, applyScreen]);

  // ---------------------------------------------------------------------------
  // Event listeners, in the old module's order.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const unlisten = listen<string>("desktop-screen", (event) => applyScreen(event.payload));
    return () => {
      // A subscription that never came up has nothing to tear down, and a
      // teardown that races the window going away must not become an
      // unhandled rejection.
      void unlisten.then((off) => off()).catch(() => {});
    };
  }, [applyScreen]);

  useEffect(() => {
    // The package manager's own output while tmux installs
    // (`INSTALL_LINE_EVENT` in control.rs). Only the LAST line is kept: the
    // screen shows what is happening now, and the full text still comes back
    // in the ActionResult for the failure case. Rendered on arrival because
    // the ordinary poll is stopped while an action runs.
    const unlisten = listen<string>("desktop-install-line", (event) => {
      const line = event.payload.trim();
      // Blank lines are spacing in the manager's output, not progress;
      // showing one would blank the only thing on screen that was saying
      // anything.
      if (line === "" || installStartedAt === 0) return;
      setInstallLine(line);
    });
    return () => {
      void unlisten.then((off) => off()).catch(() => {});
    };
  }, [installStartedAt]);

  useEffect(() => {
    // The reset chain's progress: one frame per phase transition (spec
    // 2026-09-13 — the meter exists because slow-read-as-hung was reported).
    const unlisten = listen<{ step: string; state: string }>("desktop-reset-step", (event) =>
      setResetStep({ step: event.payload.step, state: event.payload.state }),
    );
    return () => {
      void unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    // The app download's own progress. A ~100 MB bundle over a domestic link
    // is tens of seconds of a dead button otherwise, which reads as a hang —
    // the same report that put a meter on the reset chain.
    //
    // `total` is null where the release host sent no Content-Length, which is
    // a real case: the line then counts megabytes rather than claiming a
    // percentage it cannot compute.
    const unlisten = listen<{ received: number; total: number | null }>("desktop-app-update-progress", (event) => {
      const { received, total } = event.payload;
      const mb = (n: number) => (n / 1_000_000).toFixed(1);
      setUpdateProgress(
        total === null ? `Downloading… ${mb(received)} MB` : `Downloading… ${mb(received)} of ${mb(total)} MB`,
      );
    });
    return () => {
      void unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  // ---------------------------------------------------------------------------
  // The handoff latch and the ready handoff's one automatic open.
  // ---------------------------------------------------------------------------

  /**
   * Whether the probe implies a journey screen — the condition the old
   * render's list-non-empty path ran under.
   */
  const journeyListed = probe !== null && screensFor(probe, probe.onboarded).length > 0;
  /**
   * The route, gated on the boot sequence.
   *
   * The old page rendered NOTHING between the probe and the pendingScreen
   * pull — `refresh()` set `probe` and rendered nothing, so nothing could
   * slip between them and take the ready handoff. A React `setProbe` flushes
   * a render, so without this gate a window opened FOR reset or update on a
   * ready machine would route the handoff first: the latch would fire, the
   * dashboard would open, and the requested screen would apply to a window
   * already closing. `booted` flips only after the pull, so until then the
   * host stays on `boot` and every effect below that keys off `r.kind`
   * (the latch, the auto-open) cannot fire early.
   */
  const r = booted ? route(probe, screen, { running, failure }) : { kind: "boot" };

  /**
   * The correction ratchet: the old `render()` OVERWROTE `screen` with its
   * resolution, so a screen the probe no longer offers was corrected once
   * and stayed corrected. This effect is that overwrite. Without it, a
   * corrected screen that re-enters `screensFor`'s list later — tmux
   * disappearing again, say — would flip the window back to the screen the
   * person already left.
   *
   * Exactly the old render's guard, then: only a NON-null screen that is not
   * requested and is not on the list; a null screen keeps meaning "whatever
   * the probe implies" and is re-derived every render here, and a requested
   * screen routes by its request alone and is never corrected onto the
   * journey.
   */
  useEffect(() => {
    if (!booted || probe === null || screen === null || isRequestedScreen(screen)) return;
    const resolved = resolveJourney(probe, screen);
    if (resolved !== null && resolved !== screen) setScreen(resolved);
  }, [booted, probe, screen]);

  useEffect(() => {
    if (r.kind === "handoff") {
      // The ready handoff fires its entrance ONCE. Unguarded, `next ===
      // "ready"` stays true on every later poll and the replay fired every
      // 1500 ms forever, visibly on the `openFailed` screen, which stays up
      // indefinitely. `screen` goes to null with it, so that leaving the
      // handoff and coming back resolves from the probe again.
      if (!handedOff) {
        setHandedOff(true);
        setScreen(null);
      }
      return;
    }
    // The un-latch is where the old render put it: in the JOURNEY branch,
    // after the requested/reset/boot arms had returned — a requested screen
    // never un-latches the handoff behind it.
    if (
      handedOff &&
      journeyListed &&
      (r.kind === "welcome" || r.kind === "tmux" || r.kind === "setup" || r.kind === "status")
    ) {
      setHandedOff(false);
    }
  }, [r.kind, handedOff, journeyListed]);

  useEffect(() => {
    if (r.kind !== "handoff") return;
    if (probe === null) return;
    // The waiting arm owes a Continue, not an automatic open: a chain that
    // ran in THIS window ends on the completed checklist with the person's
    // press (see `handoffView`). `openWhenReady` is the SAME call both arms
    // reach, so the dashboard opening is identical whichever door it opens
    // through.
    if (handoffView({ onboarded: probe.onboarded, ranSetupHere, continued }).wait) return;
    if (opened || probe.next !== "ready") return;
    setOpened(true);
    void ipc.openMain().catch((err: unknown) => {
      setOpenFailed(true);
      setProblem(errText(err));
    });
  }, [r.kind, probe, ranSetupHere, continued, opened]);

  // ---------------------------------------------------------------------------
  // Enter presses the bar's primary, as the old page's document keydown did.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Enter inside a textarea is a newline, and on a focused button it is
      // that button's own activation — doubling it here would press the
      // primary on top of the ghost the person aimed at.
      if (e.key !== "Enter" || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLButtonElement) {
        return;
      }
      const primary = document.querySelector<HTMLButtonElement>('[data-slot="bar-right"] button.primary');
      if (primary && !primary.disabled) primary.click();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // ---------------------------------------------------------------------------
  // The poll, on the `nextPollDelay` seam.
  // ---------------------------------------------------------------------------

  const hidden = useDocumentHidden();

  /**
   * One poll pass: refresh the probe, and pull the log tail only while
   * someone is looking at it. A tail pulled on every tick for a collapsed
   * disclosure is a CLI spawn per 1500 ms for a view nobody can see.
   *
   * There is no render-signature gate here: the old `pollShouldRender` churn
   * machinery existed because every redraw tore the DOM down, and a rebuild
   * landing between mousedown and mouseup ate the click. React reconciliation
   * does not destroy an element under a pressed pointer, so that class of
   * defect — and the gate — is gone structurally.
   */
  const tick = useCallback(async (): Promise<void> => {
    try {
      await refresh();
    } catch {
      return;
    }
    if (detailsOpen) {
      try {
        setLastTail(await ipc.logs());
      } catch {
        /* the pane keeps its last content */
      }
    }
  }, [refresh, detailsOpen]);

  useEffect(() => {
    if (!booted) return;
    const delay = nextPollDelay({ busy, running, hidden });
    if (delay === null) return;
    const id = setInterval(() => void tick(), delay);
    return () => clearInterval(id);
  }, [booted, busy, running, hidden, tick]);

  // ---------------------------------------------------------------------------
  // What the screens receive.
  // ---------------------------------------------------------------------------

  const actions = useMemo<HostActions>(
    () => ({
      probe: () => probe,
      busy: () => busy || running,
      setBusy,
      refresh,
      fail,
      close,
      rearmFirstRun,
      go,
    }),
    [probe, busy, running, setBusy, refresh, fail, close, rearmFirstRun, go],
  );

  // The content region is the screens' (Tasks 3–7); until they land it is an
  // empty, marked region. The route is already computed and the poll, the
  // latches and the listeners are already live — only the rendering waits.
  // `data-route` is the transition's one window into the routing: the tests
  // that pin the boot gate and the correction read it, and it is deleted with
  // this placeholder in Task 8.
  return (
    <HostActionsContext.Provider value={actions}>
      <Frame
        strings={
          r.kind === "boot"
            ? // The boot frame's strings, transcribed from the old render's
              // `probe === null` arm.
              { title: "Welcome to Subshell", subtitle: "Checking this machine…", problem }
            : { title: "", subtitle: "", problem }
        }
        art={
          r.kind === "boot" ? (
            // The wordmark, transcribed from the old page's ART.icon: the CSP
            // allows no remote images, so the fixed set is local.
            <img src="./wordmark-96.png" srcSet="./wordmark-96.png 1x, ./wordmark-192.png 2x" alt="" />
          ) : undefined
        }
      >
        {/* Task 3+: the screens land here — this region is empty until then. */}
        <div data-task="3+" data-route={r.kind} />
      </Frame>
    </HostActionsContext.Provider>
  );
}
