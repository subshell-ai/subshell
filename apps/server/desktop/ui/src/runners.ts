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
import type { ActionResult, Probe } from "./lib/ipc";
import * as ipc from "./lib/ipc";
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

  return { act, startSetup, startTmuxInstall, pickBinary, runRecovery, refreshTail };
}
