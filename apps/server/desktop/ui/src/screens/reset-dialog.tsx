/**
 * The Reset confirmation as a DIALOG (operator ruling 2026-09-23; the Subshell
 * Client assistant's proven shape, ported) — the re-home of the screen that
 * used to replace the frame, and of `assistant/reset-view.ts` before it.
 *
 * The rail's danger item opens it over whatever section stands; nothing about
 * the section changes, no route moves, and the section keeps its share of the
 * rail highlight. What the room ruled, the modal rules harder: "no navigation
 * beside a chain that is deleting this server" — a modal IS that, and while
 * the chain runs Escape and the backdrop are inert and Cancel is disabled, so
 * the one running thing cannot be walked away from. The old ruling that the
 * rail is the way out of the confirmation is superseded by this: under a modal
 * the rail is unreachable on purpose, so Cancel lives here again, disabled
 * only while the chain runs.
 *
 * What stays verbatim from the screen is the CONSENT, which is the whole
 * reason the confirmation exists: the page supplies a HOSTNAME, never a path;
 * the delete plan was armed the moment the dialog opened, and a refusal says
 * so instead of offering a button that would refuse. The meter, the arming
 * verdict, the half-run log AND the typed hostname are HOST state — page state
 * in the old module, for the same reason: the poll re-renders on its own
 * clock, so a state the DOM held would be erased mid-chain. The hostname rides
 * the host because the old input survived Cancel and a reopen, and dropping
 * this component would otherwise clear what the person had already typed.
 */
import type { ReactElement } from "react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Probe } from "../lib/ipc";
import { armed, RESET_STEPS, refusal, resetRows, resetStarted, type StepKey, type StepState } from "../lib/reset";
import { RESET_LABEL } from "../lib/wizard-state";

/** What the run left behind: its own words, and whether they are bad news. */
export interface ResetLog {
  text: string;
  bad: boolean;
}

export function ResetDialog(props: {
  probe: Probe | null;
  /** `busy || running` — the old `host.busy()`, which folded the chain in. */
  busy: boolean;
  /** The meter's rows, merged live from the `desktop-reset-step` events. */
  steps: Record<StepKey, StepState>;
  /** Why the last arming attempt did not stage a plan, or null when it did. */
  armingProblem: string | null;
  /** The run button's label at rest; a half-run promotes it to "Retry reset". */
  runLabel: string;
  log: ResetLog | null;
  /** The typed hostname — host state, so it survives Cancel and a reopen. */
  typed: string;
  onTypedChange: (typed: string) => void;
  onRunReset: (typed: string) => void;
  /** Close the dialog. The section underneath is exactly where it was. */
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
  // Bring the half-run's log into view. It sits below the confirm row — a
  // chain that answered was answering off-screen, and the press read as a
  // button that did nothing. The same mistake as the refusal line, one
  // element further down: writing the truth somewhere the reader is not.
  const logRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    if (log !== null && log.text !== "") logRef.current?.scrollIntoView({ block: "nearest" });
  }, [log]);

  return (
    <Dialog
      // The pane's title, same predicate the frame's carried: the meter's own
      // heading while the chain runs, the door's word otherwise (RESET_LABEL
      // is one string for the rail's door and the dialog it opens).
      title={started ? "Resetting this server" : RESET_LABEL}
      // While the chain runs the dismissal is inert: a running reset keeps
      // its old room's one rule, that nothing ends it but its own end.
      onClose={busy ? () => undefined : props.onCancel}
    >
      {/* Two panes, one at a time. Confirming and watching are different
          screens: the promises are what you read BEFORE pressing, and once the
          chain is stopping services and deleting directories the only thing
          worth the window is how far it has got. A press does not extend the
          confirmation, it REPLACES it. */}
      <div hidden={started}>
        <p className="hint empty:hidden">{refusalLine}</p>
        {why === null && st !== undefined && st !== null && (
          <ul className="wizard-copy list-disc pl-5 max-h-[40vh] overflow-y-auto">
            {rows.map((row) => (
              <li key={row.label} className="break-all">
                {`${row.label}: ${row.path}`}
              </li>
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
        {/* `busy` belongs in this gate as much as the refusal does. Without it
            the button stayed lit and lettered "Reset everything" through a
            chain that stops a service and sweeps hundreds of sockets, so the
            one press that matters looked like it had not registered and
            invited a second. */}
        <Button
          type="button"
          disabled={busy || !(why === null && armedOk)}
          data-armed={String(armedOk)}
          onClick={() => props.onRunReset(typed)}
        >
          {busy ? "Resetting…" : runLabel}
        </Button>
        {/* Cancel is the dialog's own refusal (the modal supersedes the
            rail-is-the-exit ruling: under an overlay the rail cannot be
            reached, so the way out lives here), disabled while the chain runs
            — nothing on the progress pane may offer an act the chain cannot
            honour. */}
        <Button type="button" variant="outline" disabled={busy} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
      {/* The reason, beside the control it disables. Only for a REFUSAL: "you
          have not typed the hostname yet" is what the label above the box
          already says, and repeating it under the button would nag through
          every keystroke of a correct answer. */}
      <p className="hint warn-text empty:hidden">{why ?? ""}</p>
    </Dialog>
  );
}
