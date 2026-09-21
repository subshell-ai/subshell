/**
 * The Reset screen (spec § 7.1 of the 2026-09-10 design; a screen rather than
 * a takeover since spec 2026-09-12 § 5.3).
 *
 * Entered by the `desktop-screen` event from the dashboard's danger card, or
 * by the recovery screen's footer link; it renders the captured-plan truth
 * from the live probe and compares the typed hostname the same way Rust will
 * (displayed value wins nowhere: both sides read the probe's single memo,
 * R15).
 *
 * It still covers the whole window, and the reason is unchanged even though
 * there is no sidebar left to cover: this screen's premise is that it is the
 * only thing happening, so the assistant's own frame and its bottom bar go
 * with it — a Back button live through a chain that stops a service and
 * sweeps sockets is a way out from under a screen that has none.
 */
import * as ipc from "../lib/ipc";
import {
  armed,
  emptySteps,
  knownStep,
  RESET_STEPS,
  refusal,
  resetRows,
  resetStarted,
  type StepState,
} from "../lib/reset";
import { type AssistantHost, el, errText } from "./host";

export interface ResetView {
  /** Whether the screen is up, so the page renders it instead of a frame screen. */
  isOpen(): boolean;
  render(): void;
  /** Arm a plan and raise the screen. */
  open(): Promise<void>;
  /** Drop the screen without arming anything — the page's own `close()` path. */
  hide(): void;
  /** Merge one `desktop-reset-step` frame from the running chain. */
  applyStep(step: unknown, state: unknown): void;
}

export function createResetView(host: AssistantHost): ResetView {
  let open = false;

  /**
   * The meter's rows. PAGE state like `armingProblem` and the same reason:
   * `#content` and this screen rebuild on every render and the poll renders
   * on its own clock, so a state the DOM held would be erased mid-chain.
   */
  let steps = emptySteps();

  /**
   * Why the last arming attempt did not stage a plan, or null when it did.
   *
   * The screen must never present an armed-looking box over an empty stash.
   * That combination produced the one bug this screen has actually shipped: a
   * `tauri dev` session hot-reloads this page but NOT the Rust side, so a page
   * calling a command the running binary does not carry had its invoke
   * rejected, opened anyway, and answered a correctly typed hostname with
   * "no reset plan is staged". The arming outcome is a fact about the screen,
   * so the screen holds it.
   */
  let armingProblem: string | null = null;

  /**
   * The run button's label at rest. Held here rather than read back off the
   * element, so the busy label can be swapped in and out without the resting
   * one having to survive a round trip through the DOM: a half-run promotes
   * this to "Retry reset" and it must stay promoted across every later render.
   */
  let resetRunLabel = "Reset everything";

  function render(): void {
    const st = host.probe()?.status;
    const host_name = host.probe()?.hostname ?? "";
    const why = armingProblem ?? refusal(st);
    // One sentence names one cause. A paths block that is complete but a name
    // that could not be read still leaves the button disabled (armed() refuses
    // an empty hostname) - and no control is disabled without its reason named
    // beside it, which is what this line is for.
    el("reset-refusal").textContent =
      why ??
      (host_name === ""
        ? "This machine's name could not be read, so there is nothing reset can confirm against; it refuses rather than arming on an empty box."
        : "");
    const rows = el("reset-rows");
    rows.textContent = "";
    if (why === null && st !== undefined && st !== null) {
      for (const row of resetRows(st)) {
        const li = document.createElement("li");
        li.textContent = `${row.label}: ${row.path}`;
        rows.append(li);
      }
    }
    el("reset-disclosures").textContent =
      "Enrolled remote nodes and a node agent on this machine keep running and are NOT touched. Only the locations listed above are deleted, permanently; the installed server binary stays.";
    el("reset-hostname").textContent = host_name;
    const typed = (el("reset-confirm") as HTMLInputElement).value;
    // `busy` belongs in this gate as much as the refusal does. Without it the
    // button stayed lit and lettered "Reset everything" through a chain that
    // stops a service and sweeps hundreds of sockets, so the one press that
    // matters looked like it had not registered and invited a second.
    (el("reset-run") as HTMLButtonElement).disabled = host.busy() || !(why === null && armed(typed, host_name));
    el("reset-run").textContent = host.busy() ? "Resetting…" : resetRunLabel;
    el("reset-run").dataset.armed = String(armed(typed, host_name));
    // Cancel goes with it, on the SAME predicate, and the reason is what the
    // action row now sits under. Beside the hostname box it meant "never
    // mind" — the only thing there to abandon was a half-typed name. Under
    // the meter it reads as "cancel this reset", which is the one thing it
    // cannot do: it is `hide()` + `host.close()`, so a press would leave the
    // chain stopping services and deleting directories in Rust with the
    // window that was reporting it gone. Nothing on the progress pane may
    // offer an act the chain cannot honour. `busy` ends on every exit path
    // the run handler has, so a half-run gets Cancel back beside Retry, where
    // leaving really is a choice.
    (el("reset-cancel") as HTMLButtonElement).disabled = host.busy();
    renderPhase();
    renderSteps();
    // The reason, beside the control it disables. Only for a REFUSAL: "you
    // have not typed the hostname yet" is what the label above the box already
    // says, and repeating it under the button would nag through every
    // keystroke of a correct answer.
    el("reset-why").textContent = why ?? "";
  }

  /** True once the chain has touched anything — the moment confirming becomes watching. */
  const started = (): boolean => resetStarted(steps);

  /**
   * Which of the two panes is the screen right now.
   *
   * A press does not extend the confirmation, it REPLACES it: the promises
   * are what you read before pressing, and once services are stopping and
   * directories are going the only thing worth the window is how far it has
   * got. The meter used to render between the disclosures and the input,
   * which put a live task list ABOVE the box someone was still typing in and
   * left the whole confirmation on screen underneath it.
   */
  function renderPhase(): void {
    const running = started();
    el("reset-confirm-pane").hidden = running;
    el("reset-progress-pane").hidden = !running;
  }

  /**
   * Draw the meter in the FIRST RUN's checklist, element for element —
   * `li[data-state]` with a glyph column, which is what makes a done row's
   * green tick, a running row's spinner and a failed row's cross identical to
   * the Setting Up screen's. It is the same kind of moment and it now looks
   * like it; before this the screen carried a denser list of its own with a
   * separate set of colours and marks.
   */
  function renderSteps(): void {
    const box = el("reset-steps");
    box.textContent = "";
    if (!started()) return;
    for (const { key, label } of RESET_STEPS) {
      const state: StepState = steps[key];
      const li = document.createElement("li");
      // "active" rather than "running": the checklist's own vocabulary, and
      // the state its spinner animation is keyed to.
      li.dataset.state = state === "running" ? "active" : state;
      const glyph = document.createElement("span");
      glyph.className = "glyph";
      glyph.textContent = state === "done" ? "✓" : state === "failed" ? "✕" : "";
      const text = document.createElement("span");
      text.className = "label";
      text.textContent = label;
      li.append(glyph, text);
      box.append(li);
    }
  }

  /**
   * Raise the screen: the assistant's frame and its bar step aside, because
   * this screen owns the window while it is up.
   */
  function show(): void {
    open = true;
    el("screen").hidden = true;
    el("bar").hidden = true;
    el("reset-view").hidden = false;
    render();
  }

  /** Put the frame back. The page then renders whatever the probe implies. */
  function hide(): void {
    open = false;
    el("reset-view").hidden = true;
    el("screen").hidden = false;
    el("bar").hidden = false;
  }

  /**
   * Stage the plan, and answer why not when it could not be staged.
   *
   * Three outcomes, and the screen has to tell them apart: staged (null), the
   * CLI would not report its paths (the refusal `render` already has words
   * for, so defer to it), and the command itself was refused — which in
   * practice means a `tauri dev` session whose Rust half predates this
   * command, and which must never look like a screen that is ready to run.
   */
  async function armReset(): Promise<string | null> {
    try {
      if (await ipc.armReset()) return null;
      return (
        refusal(host.probe()?.status) ?? "This server did not report its data locations, so there is nothing to stage."
      );
    } catch (err) {
      // Say what is out of step, not what kind of build this is. The chain
      // itself behaves the same in a dev build as in a release one; the one
      // branch is the FINAL restart (a dev build re-probes in place rather
      // than restart out of `tauri dev`'s tree), which is after anything
      // this screen can fail at. The first person to read the older wording
      // took it as a prohibition, which would have sent them looking for a
      // setting that does not exist.
      return `The reset could not be staged: ${errText(err)}. This app's window is newer than the app itself, which is what happens when a dev session reloads the page but not its Rust half; quit and relaunch it.`;
    }
  }

  /**
   * M1's promise kept by the page: a half-run's verbatim log renders where
   * the human still is, AND reads as a failure (J1) - the same `output-bad`
   * treatment the command pane gives its own, so two surfaces never phrase
   * one outcome differently. Success normally needs no rendering (the chain
   * closes this window on its way to the wizard), but the wizard-open failure
   * arm (M2) answers ok:true with a note in the log, and a half-run needs
   * Retry named (J2): the button re-labels, because the stash is deliberately
   * still held and the screen must say pressing it again is the intended,
   * safe move.
   */
  function showResetResult(text: string, bad: boolean): void {
    const box = el("reset-log");
    box.textContent = text;
    box.classList.toggle("output-bad", bad);
    box.hidden = text === "";
    if (bad) resetRunLabel = "Retry reset";
    // Bring it into view. This box sits below the confirm row, under a long
    // disclosure list - so a chain that answered was answering off-screen, and
    // the press read as a button that did nothing. The same mistake as the
    // refusal line, one element further down: writing the truth somewhere the
    // reader is not.
    if (text !== "") box.scrollIntoView({ block: "nearest" });
  }

  el("reset-confirm").addEventListener("input", render);
  el("reset-cancel").addEventListener("click", () => {
    hide();
    host.close();
  });

  el("reset-run").addEventListener("click", () => {
    void (async () => {
      const typed = (el("reset-confirm") as HTMLInputElement).value;
      if (!armed(typed, host.probe()?.hostname ?? "")) return;
      host.setBusy(true);
      // A fresh meter per press — including Retry, whose rows still show the
      // last half-run's failure. The chain re-runs from the top; the rows do
      // too. `plan` is the page's own first step: the arming round trip
      // spawns its own probes, and before the meter existed the press's
      // first one-to-three silent seconds were the same complaint.
      steps = emptySteps();
      steps.plan = "running";
      showResetResult("", false);
      host.render();
      try {
        // Re-arm on EVERY press, not just when the screen opens. The plan is
        // one-shot by design - a finished chain spends it - so a second press
        // used to answer "no reset plan is staged; the reset screen must be
        // opened again", which is a dead end telling the human to do by hand
        // exactly what this button should do. Arming is idempotent: one probe,
        // one stash, no mutation of the machine.
        //
        // A false answer means the CLI would not report its paths, so there is
        // nothing this screen can promise to delete. Say that in the words the
        // screen already uses for it rather than running into the Rust-side
        // refusal, which phrases the same fact as a staging accident.
        armingProblem = await armReset();
        if (armingProblem !== null) {
          steps.plan = "failed";
          showResetResult(armingProblem, true);
          host.setBusy(false);
          host.render();
          return;
        }
        steps.plan = "done";
        host.render();
        const result = await ipc.reset(typed);
        // The machine answered — even a partial wipe answers as a first run
        // through the refreshed probe — so the page's fired-already latch and
        // any pre-reset failure describe a machine that no longer exists.
        // The close-to-first-run handoff must meet a fresh welcome that can
        // fire again (see `AssistantHost.rearmFirstRun`).
        host.rearmFirstRun();
        const parts: string[] = [];
        if (result?.stdout?.trim()) parts.push(result.stdout.trim());
        if (result?.stderr?.trim()) parts.push(result.stderr.trim());
        showResetResult(parts.join("\n\n"), result?.ok === false);
      } catch (err) {
        // Err is the pre-flight channel (hostname mismatch, no plan, refused
        // guard): one sentence, no partial log exists to show.
        showResetResult(errText(err), true);
      }
      host.setBusy(false);
      try {
        await host.refresh();
      } catch {
        /* the machine is being deleted under us */
      }
      host.render();
    })();
  });

  return {
    isOpen: () => open,
    render,
    hide,
    applyStep(step: unknown, state: unknown): void {
      // Unknown words drop: a page newer than its binary (or the reverse,
      // which is `tauri dev` HMR's normal condition) must not invent rows.
      if (!knownStep(step, state)) return;
      steps[step] = state as StepState;
      render();
    },
    async open(): Promise<void> {
      // SHOW FIRST, then arm. The screen is open from the moment it was
      // asked for, and the plan is content that arrives after.
      //
      // Arming is an IPC round trip that spawns the server CLI, and this
      // used to `await` it before flipping `open` — so `isOpen()` answered
      // FALSE for a few hundred milliseconds after the screen had been
      // requested. The page's own boot (`await refresh(); render()`) resolves
      // inside that window, sees a ready machine with no screens left, and
      // hands off: "Opening your dashboard…", dashboard opened, assistant
      // closed. Measured on 2026-09-12 by pressing Reset on the dashboard.
      //
      // Nothing is lost by showing early. A refused arming still explains
      // itself (`render`'s `why`) the moment it answers, and the run button
      // RE-ARMS on every press, so a plan staged here was never a
      // precondition for the screen being correct — only for it being able
      // to say "no" sooner.
      // A refusal belongs to the arming that produced it. Showing first is
      // what makes the screen appear at once, so a leftover from the last
      // open would be the first thing drawn — the old "no", with the button
      // disabled, over a machine that may well now be resettable.
      armingProblem = null;
      steps = emptySteps();
      show();
      armingProblem = await armReset();
      render();
    },
  };
}
