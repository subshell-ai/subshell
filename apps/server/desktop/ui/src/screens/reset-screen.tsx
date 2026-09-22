/**
 * The Reset screen (spec 2026-09-21; plan Task 7) — the port of
 * `assistant/reset-view.ts` and its contract with `reset.rs`.
 *
 * Since the 2026-09-22 layout ruling (final word) the CONFIRMATION renders
 * inside the frame WITH the rail — the sidebar was being lost today and
 * that is not wanted — and the frame carries the pane's title
 * (`host.tsx`'s `shell("reset")`, keyed on the meter pane rather than on
 * the room). The ROOM is still this screen's while the chain runs: the
 * host withholds the rail for the chain's duration, because a Back button
 * live through a chain that stops a service and sweeps sockets is a way
 * out from under a screen that has none. The host renders this view
 * inside the frame's content region, which is what the old `show()` did
 * by hiding `#screen` and `#bar` for the chain.
 *
 * The meter, the arming verdict, the half-run log AND the typed hostname are
 * HOST state — page state in the old module, for the same reason: the poll
 * re-renders on its own clock, so a state the DOM held would be erased
 * mid-chain. The hostname rides the host because the old input was static
 * markup and never unmounted: its value survived Cancel and a reopen, and
 * dropping this component would otherwise clear what the person had already
 * typed.
 */
import type { ReactElement } from "react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Probe } from "../lib/ipc";
import { armed, RESET_STEPS, refusal, resetRows, resetStarted, type StepKey, type StepState } from "../lib/reset";

/** What the run left behind: its own words, and whether they are bad news. */
export interface ResetLog {
  text: string;
  bad: boolean;
}

export function ResetScreen(props: {
  probe: Probe | null;
  /** `busy || running` — the old `host.busy()`, which folded the chain in. */
  busy: boolean;
  /** The meter's rows, merged live from the `desktop-reset-step` events. */
  steps: Record<StepKey, StepState>;
  /** Why the last arming attempt did not stage a plan, or null when it did. */
  armingProblem: string | null;
  /** The run button's label at rest; a half-run promotes it to "Retry reset". */
  runLabel: string;
  /**
   * Whether the rail is beside this render. NO CANCEL where it is (operator
   * ruling 2026-09-22, screenshot 59): the rail is the way out of the
   * confirmation, and the running room keeps no Cancel regardless.
   */
  railPresent: boolean;
  log: ResetLog | null;
  /** The typed hostname — host state, so it survives Cancel and a reopen. */
  typed: string;
  onTypedChange: (typed: string) => void;
  onRunReset: (typed: string) => void;
  onCancel: () => void;
}): ReactElement {
  const { probe, busy, steps, armingProblem, runLabel, log, typed } = props;
  const st = probe?.status;
  const hostname = probe?.hostname ?? "";
  // One sentence names one cause. A paths block that is complete but a name
  // that could not be read still leaves the button disabled (armed() refuses
  // an empty hostname) — and no control is disabled without its reason named
  // beside it, which is what this line is for.
  const why = armingProblem ?? refusal(st);
  const refusalLine =
    why ??
    (hostname === ""
      ? "This machine's name could not be read, so there is nothing reset can confirm against; it refuses rather than arming on an empty box."
      : "");
  const rows = why === null && st ? resetRows(st) : [];
  const armedOk = armed(typed, hostname);
  const started = resetStarted(steps);
  // Bring the half-run's log into view. It sits below the confirm row, under
  // a long disclosure list — a chain that answered was answering off-screen,
  // and the press read as a button that did nothing. The same mistake as the
  // refusal line, one element further down: writing the truth somewhere the
  // reader is not.
  const logRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    if (log !== null && log.text !== "") logRef.current?.scrollIntoView({ block: "nearest" });
  }, [log]);

  return (
    <div className="reset-view">
      {/* Two panes, one at a time. Confirming and watching are different screens:
          the promises are what you read BEFORE pressing, and once the chain is
          stopping services and deleting directories the only thing worth the
          window is how far it has got. A press does not extend the
          confirmation, it REPLACES it. */}
      <div hidden={started}>
        {/* The pane's title lives in the frame now (shell("reset")), keyed on
            this pane — the ruling moved the confirmation under the rail, and
            a second heading under the frame's own was the duplication that
            came with it. */}
        <p className="hint mb-2.5">{refusalLine}</p>
        {why === null && st !== undefined && st !== null && (
          <ul className="wizard-copy list-disc pl-5">
            {rows.map((row) => (
              <li key={row.label}>{`${row.label}: ${row.path}`}</li>
            ))}
          </ul>
        )}
        <div className="wizard-copy text-sm muted-text mb-2.5">
          {
            "Enrolled remote nodes and a node agent on this machine keep running and are NOT touched. Only the locations listed above are deleted, permanently; the installed server binary stays."
          }
        </div>
        <label className="mb-1 block text-sm" htmlFor="reset-confirm">
          {`Type this machine's hostname to confirm, exactly as shown: `}
          <code>{hostname}</code>
        </label>
        <div className="flex gap-2">
          <Input
            id="reset-confirm"
            className="min-w-0 flex-1"
            value={typed}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => props.onTypedChange(e.currentTarget.value)}
          />
        </div>
      </div>
      <div hidden={!started}>
        {/* Titles live in the frame (shell("reset")); the meter is the pane's
            own content. */}
        {/* The meter in the FIRST RUN's checklist, element for element —
            li[data-state] with a glyph column, which is what makes a done row's
            green tick, a running row's spinner and a failed row's cross
            identical to the Setting Up screen's. "active" rather than
            "running": the checklist's own vocabulary, and the state its
            spinner animation is keyed to. */}
        <ul className="checklist" aria-live="polite">
          {started &&
            RESET_STEPS.map(({ key, label }) => {
              const state = steps[key];
              return (
                <li key={key} data-state={state === "running" ? "active" : state}>
                  <span className="glyph">{state === "done" ? "✓" : state === "failed" ? "✕" : ""}</span>
                  <span className="label">{label}</span>
                </li>
              );
            })}
        </ul>
        {/* M1's promise kept by the page: a half-run's verbatim log renders where
            the human still is, AND reads as a failure (J1) — the same
            `output-bad` treatment the command pane gives its own, so two
            surfaces never phrase one outcome differently. */}
        <pre
          ref={logRef}
          className={`pane-pre mt-3${log?.bad ? " output-bad" : ""}`}
          aria-live="polite"
          hidden={log === null || log.text === ""}
        >
          {log?.text ?? ""}
        </pre>
      </div>
      {/* ONE action row, below whichever pane is showing. It is a sibling of both
          rather than a copy in each, so Reset and Cancel keep one definition. */}
      <div className="mt-3 flex justify-end gap-2">
        {/* `busy` belongs in this gate as much as the refusal does. Without it the
            button stayed lit and lettered "Reset everything" through a chain that
            stops a service and sweeps hundreds of sockets, so the one press that
            matters looked like it had not registered and invited a second. */}
        <Button
          type="button"
          disabled={busy || !(why === null && armedOk)}
          data-armed={String(armedOk)}
          onClick={() => props.onRunReset(typed)}
        >
          {busy ? "Resetting…" : runLabel}
        </Button>
        {/* Cancel renders only in a rail-LESS render and never while the chain
            runs (operator ruling 2026-09-22, screenshot 59, superseding the
            half-run Cancel: the rail is the way out of the confirmation, and
            the room keeps no exit at all — a press would leave the chain
            stopping services and deleting directories in Rust with the
            window that was reporting it gone). Beside the hostname box it
            meant "never mind" — the only thing there to abandon was a
            half-typed name. */}
        {!props.railPresent && !busy && (
          <Button type="button" variant="outline" onClick={props.onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {/* The reason, beside the control it disables. Only for a REFUSAL: "you
          have not typed the hostname yet" is what the label above the box
          already says, and repeating it under the button would nag through
          every keystroke of a correct answer. */}
      <p className="hint warn-text empty:hidden">{why ?? ""}</p>
    </div>
  );
}
