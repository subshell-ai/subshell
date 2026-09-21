/**
 * The action layer — `act`, `startSetup`, `startTmuxInstall`, `pickBinary`,
 * `runRecovery` and `refreshTail`, ported from `wizard.ts` (spec 2026-09-21;
 * plan Task 3).
 *
 * These were module functions over the page's mutable vars; they are now one
 * hook over the host's state bag, recreated each render so every closure reads
 * the CURRENT state at press time — the same read the old module var gave.
 * The one exception is a read ACROSS an await (the settle loops' `probe.next`
 * checks), which goes through `deps.probeRef`: the old code read a module var
 * that had moved on by then, and a render-time closure would not.
 *
 * There are no `render()` calls here. The old functions repainted after every
 * write because the DOM was imperative; each `setState` below re-renders on
 * its own.
 */
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { RefObject } from "react";
import { configPayload, type ExplicitMap, type FormValues } from "./lib/config-form";
import type { ActionResult, AppUpdateCheck, Probe } from "./lib/ipc";
import * as ipc from "./lib/ipc";
import { type ActState, rejectedResult } from "./lib/update-act";
import { failureLine, type RecoveryActionKind, type SupervisionChoice } from "./lib/wizard-state";

/** A rejected command's words. Same one-liner as `host.tsx`'s, for the same reason. */
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * How long a successful setup chain waits for the server to answer before it
 * stops holding the progress screen up.
 *
 * Generous on purpose: the cost of being too short is the run visibly going
 * backwards into a question already answered, and the cost of being too long
 * is a spinner on a machine that has genuinely failed — which the recovery
 * family is built to explain anyway, on the next launch.
 */
export const SETTLE_BUDGET_MS = 30_000;

/** What the runners read and write. Everything else on the page stays out of reach. */
export interface RunnerDeps {
  /** The live probe, across awaits (the old module var's read). */
  probeRef: RefObject<Probe | null>;
  probe(): Probe | null;
  busy(): boolean;
  running(): boolean;
  supervision(): SupervisionChoice;
  form(): FormValues;
  explicit(): ExplicitMap;
  refresh(): Promise<void>;
  setProblem(problem: string): void;
  setBusy(on: boolean): void;
  setRunning(on: boolean): void;
  setFailure(result: ActionResult | null): void;
  setLastResult(result: ActionResult | null): void;
  setInstallStartedAt(at: number): void;
  setTmuxResult(result: ActionResult | null): void;
  setInstallLine(line: string): void;
  setTmuxOutputScroll(px: number): void;
  setContinued(on: boolean): void;
  setRanFirstRunHere(on: boolean): void;
  setRanSetupHere(on: boolean): void;
  setLastTail(tail: Awaited<ReturnType<typeof ipc.logs>> | null): void;
  /** The update act's state machine, its release answer, and its words. */
  updateState(): ActState;
  appUpdate(): AppUpdateCheck | null;
  setUpdateState(state: ActState): void;
  setAppUpdate(check: AppUpdateCheck | null): void;
  setUpdateProgress(line: string): void;
  setUpdateResult(result: ActionResult | null): void;
  /** The addresses screen's own last Save or Restart. */
  setSettingsResult(result: ActionResult | null): void;
  /** Leave a requested screen — `applySupervision` closes on success. */
  close(): void;
}

export function useAssistantRunners(deps: RunnerDeps) {
  /**
   * Run one press: nothing else may run beside it, the screen always
   * re-renders, and a rejection is surfaced rather than leaving every control
   * disabled.
   *
   * `settle` asks for the extra re-probes. Pass it when the whole POINT of
   * the press is a running server (install, start, update): `service start`
   * returns when the manager has spawned the process, not when the port is
   * bound, so a single re-probe reads "installed but not running" on a server
   * that came up fine — and the recovery screen would snap back to the
   * diagnosis the press had just fixed.
   */
  const act = async (fn: () => Promise<ActionResult | null>, settle = false): Promise<void> => {
    if (deps.busy() || deps.running()) return;
    deps.setBusy(true);
    deps.setProblem("");
    deps.setLastResult(null);
    try {
      const r = await fn();
      deps.setLastResult(r);
      if (r && !r.ok) deps.setProblem(failureLine(r));
    } catch (err) {
      deps.setProblem(errText(err));
    }
    await deps.refresh().catch((err: unknown) => deps.setProblem(errText(err)));
    for (let i = 0; settle && i < 2 && deps.probeRef.current?.next !== "ready"; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      await deps.refresh().catch(() => {});
    }
    deps.setBusy(false);
    // The tmux install's clock stops with the act that owns it.
    deps.setInstallStartedAt(0);
  };

  /**
   * The setup chain. Ported line for line, including the settle deadline that
   * replaced the old two-looks-three-seconds, and the finally block whose
   * ordering is load-bearing: `ranSetupHere` is recorded even when the settle
   * loop timed out, and `running` is cleared LAST, after the loop — clearing
   * it early left the poll re-rendering the question the person had just
   * answered while the run visibly went forwards, backwards, then forwards
   * again.
   */
  const startSetup = async (): Promise<void> => {
    const probe = deps.probe();
    if (deps.busy() || deps.running() || probe === null) return;
    deps.setRunning(true);
    deps.setFailure(null);
    deps.setProblem("");
    // A new run earns its own dismissal. `continued` latches the ready
    // screen's press for the window; leaving it set would let a SECOND chain
    // auto-navigate on the FIRST visit's press, which is the skipped-press
    // bug back. `ranSetupHere` is NOT cleared: a completed chain that ran
    // here is still one that ran here.
    deps.setContinued(false);
    // Captured HERE because it cannot be read later: the probe flags
    // `onboarded` on the very `ready` this chain is about to produce.
    deps.setRanFirstRunHere(!probe.onboarded);
    let result: ActionResult | null = null;
    try {
      result = await ipc.setup({ ...configPayload(deps.form(), deps.explicit()), supervision: deps.supervision() });
      if (result && !result.ok) deps.setFailure(result);
      await deps.refresh().catch(() => {});
      if (result?.ok) {
        // `service start` returns when the manager has SPAWNED the process,
        // not when the port is bound — so a successful chain routinely lands
        // here with the machine not yet ready, and this waits for it. A
        // deadline rather than a count, and long enough to cover a cold start
        // rather than a warm one. Still BOUNDED: a server that never answers
        // has to leave the person somewhere with a button.
        const readyBy = Date.now() + SETTLE_BUDGET_MS;
        while (deps.probeRef.current?.next !== "ready" && Date.now() < readyBy) {
          await new Promise((r) => setTimeout(r, 750));
          await deps.refresh().catch(() => {});
        }
      }
    } catch (err) {
      deps.setProblem(errText(err));
    } finally {
      // A chain that ran here earns the ready screen a button (see
      // `handoffView`). Recorded even when the settle loop timed out.
      if (result?.ok) deps.setRanSetupHere(true);
      // CLEARED LAST, after the settle loop — not the moment `setup` returns.
      deps.setRunning(false);
    }
  };

  /**
   * Install tmux — the one press, from both screens that offer it.
   *
   * **It asks the machine before it asks the package manager.** Someone who
   * has gone off to a terminal, installed tmux by hand and come back is
   * pressing this button to say "look again", not to run brew a second time —
   * and the poll cannot have noticed for them, because it skips while an
   * action is in flight and this screen's whole state is that nothing is. A
   * tmux found here clears the failure and returns: `screensFor` stops
   * listing this screen on the render that follows, which is the same exit
   * the poll takes.
   *
   * The clock is stamped AFTER that check rather than at the press, so the
   * progress pane never counts a probe as install time.
   */
  const startTmuxInstall = (): void => {
    if (deps.busy() || deps.running()) return;
    void act(async () => {
      // Cleared BEFORE the probe, not after it. The progress pane is on
      // screen for the length of the round trip — and with the old line still
      // under it, a Try again spent that time showing the PREVIOUS run's last
      // word beneath a fresh spinner.
      deps.setTmuxResult(null);
      deps.setInstallLine("");
      // A new run's output is a new document — keeping the old offset would
      // open the next failure's pane part-way down it.
      deps.setTmuxOutputScroll(0);
      await deps.refresh();
      if (deps.probeRef.current?.tmux != null) return null;
      deps.setInstallStartedAt(Date.now());
      try {
        const result = await ipc.installTmux();
        deps.setTmuxResult(result);
        return result;
      } catch (err) {
        deps.setTmuxResult({ ok: false, stdout: "", stderr: errText(err) });
        throw err;
      }
    });
  };

  /** Pick an existing server binary — the recovery screen's no-server act. */
  const pickBinary = async (): Promise<void> => {
    const chosen = await openDialog({ multiple: false, directory: false, title: "Choose subshell-server" });
    if (!chosen) return; // a cancel must not clear the stored choice
    await act(async () => {
      await ipc.setServerBin(chosen);
      return null;
    });
  };

  /** Run the recovery screen's one action. Each is an existing path, named. */
  const runRecovery = (kind: RecoveryActionKind): void => {
    switch (kind) {
      // A press that only re-probes still goes through `act`, so it disables
      // the screen and surfaces a refusal like every other press does.
      case "retry":
        void act(async () => null);
        return;
      case "choose-binary":
        void pickBinary();
        return;
      case "setup":
        void startSetup();
        return;
      case "install-service":
        void act(() => ipc.service("install", false), true);
        return;
      case "start":
        void act(() => ipc.service("start", false), true);
        return;
    }
  };

  /** Pull a fresh tail for the Show Details pane. Failure leaves the last one. */
  const refreshTail = async (): Promise<void> => {
    try {
      deps.setLastTail(await ipc.logs());
    } catch {
      return;
    }
  };

  /**
   * Ask Rust whether a newer app exists, and re-render around the answer.
   *
   * `force` is a press of Check Again rather than the screen opening. It
   * re-asks where a cached answer already exists; without it the screen's own
   * first render would re-ask on every render, which is the poll this screen
   * exists to stay off.
   */
  const runUpdateCheck = async (force: boolean): Promise<void> => {
    if (deps.updateState() !== "idle") return;
    if (deps.appUpdate() !== null && !force) return;
    deps.setUpdateState("checking");
    try {
      deps.setAppUpdate(await ipc.checkAppUpdate());
    } catch (err) {
      // An `Err` here is the plugin refusing — a build with no public key, a
      // malformed endpoint — not "there is no update", which arrives as a
      // `reason`. It belongs on the problem line like every other refusal.
      deps.setProblem(errText(err));
      deps.setAppUpdate(null);
    } finally {
      deps.setUpdateState("idle");
    }
  };

  /**
   * Phase 1's app half: download, verify, install, write the marker, relaunch.
   *
   * Does not resolve on success: the app restarts out from under this page,
   * and the CLI half runs in the build that comes up (see `finishUpdate`). A
   * rejection is therefore always a real failure, which is why the `catch`
   * puts it on the problem line rather than treating it as a state to render.
   *
   * **Both arguments are the SELECTION** (spec § 13), and they are the only
   * things this press carries: `bundled` false writes no marker, so phase 2
   * does not run at all, and `forced` is the Force box's answer to a restart
   * that happens in another process. Neither is re-derived on the far side —
   * the marker IS the record, which is what keeps one answer in one place.
   */
  const startAppUpdate = async (forced: boolean, bundled: boolean): Promise<void> => {
    if (deps.updateState() !== "idle") return;
    deps.setUpdateState("downloading");
    deps.setUpdateProgress("Starting the download…");
    try {
      await ipc.installAppUpdate(forced, bundled);
    } catch (err) {
      deps.setProblem(errText(err));
      deps.setUpdateState("idle");
      deps.setUpdateProgress("");
    }
  };

  /**
   * The CLI half: install the server this app ships, then restart the service.
   *
   * Both phases end here — the act when the app is already current, and phase
   * 2 after the relaunch — because it is the same two steps either way. What
   * differs is only the pane-safety answer, which the CALLER supplies, and the
   * difference is a consent rule rather than a mechanism: a PRESS consents to
   * what the screen says now (the Force box), while the automatic resume
   * carries the answer the marker recorded, because nobody is at the window to
   * ask.
   *
   * **A REJECTION is recorded as a result too**, which is not bookkeeping:
   * `act` turns a throw into the problem line and leaves `updateResult` null,
   * and null reads to the screen as "nothing has been attempted in this
   * window" — so the finishing phase showed an error line under "Installing
   * the server it ships…" with no Try Again, and with the automatic fire
   * already latched for the visit there was nothing left to press (review,
   * 2026-09-18). The throw is re-raised so `act` still says what went wrong.
   */
  const finishUpdate = async (forced: boolean): Promise<void> => {
    await act(async () => {
      // **Set INSIDE the callback, so the `finally` below always answers it**
      // (review, 2026-09-18). `act` early-returns when something else is
      // already in flight, and this line lived outside it — so a declined run
      // left "Installing the server it ships…" on screen for the rest of the
      // visit with nothing running behind it.
      //
      // The line exists because the CLI half can take minutes — `update
      // --from` is budgeted at 300 s — and emits nothing on the way, so the
      // screen would otherwise be silent beside a dead button.
      deps.setUpdateProgress("Installing the server it ships…");
      try {
        const installed = await ipc.installServer();
        deps.setUpdateProgress("Restarting the server…");
        deps.setUpdateResult(installed);
        if (!installed.ok) return installed;
        // `--force` only where the definition would refuse over live panes;
        // the CLI rejects the flag on every other verb.
        const restarted = await ipc.service("restart", forced);
        deps.setUpdateResult(restarted);
        return restarted;
      } catch (err) {
        deps.setUpdateResult(rejectedResult(errText(err)));
        throw err;
      } finally {
        deps.setUpdateProgress("");
      }
    }, true);
  };

  /**
   * Run one of the addresses screen's two acts, keeping its result where the
   * screen can render it.
   *
   * `act` already settles and re-probes; what it cannot do is say WHICH
   * screen the words belong to, because `lastResult` is the page's and every
   * screen writes it. One wrapper rather than two, so Save and Restart cannot
   * come to report themselves differently.
   */
  const runSettings = async (fn: () => Promise<ActionResult>): Promise<void> => {
    deps.setSettingsResult(null);
    await act(async () => {
      const result = await fn();
      deps.setSettingsResult(result);
      return result;
    }, true);
  };

  /**
   * Apply the supervision screen's choice.
   *
   * Leaving IS the confirmation: this screen's whole subject is a choice, and
   * staying on it with a greyed-out Apply is the only feedback a success
   * would otherwise get. A failure keeps the screen, where its log has just
   * been rendered.
   */
  const applySupervision = async (choice: SupervisionChoice): Promise<void> => {
    await act(async () => {
      const result = await ipc.setSupervision(choice.background ? "service" : "app", choice.autostart);
      if (result.ok) deps.close();
      return result;
    }, true);
  };

  return {
    act,
    startSetup,
    startTmuxInstall,
    pickBinary,
    runRecovery,
    refreshTail,
    runUpdateCheck,
    startAppUpdate,
    finishUpdate,
    runSettings,
    applySupervision,
  };
}
