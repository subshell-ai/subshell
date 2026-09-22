/**
 * The ONE screen a machine that has been set up sees while its server is not
 * answering (spec 2026-09-21; plan Task 4) — the port of `renderRecovery`,
 * including the `.recovery-links` stack, the tmux warning as a keyed
 * component, and the gated primary action.
 *
 * The title IS the diagnosis, there is one primary action, and everything a
 * person repairing an install would otherwise have opened a console for sits
 * behind Show Details. The screen's progress and failure variants render
 * through the setup screen's exports — the old `renderRecovery` called the
 * same `renderProgress`/`renderFailure` it did.
 */
import { type AssistantStrings, Frame } from "@internal/assistant";
import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import type { FormValues } from "../lib/config-form";
import { tmuxInstallPlan } from "../lib/installers";
import type { About, ActionResult, LogTail, OpenTarget, Probe } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import {
  RESET_LABEL,
  type RecoveryActionKind,
  recoveryAction,
  type ScreenId,
  type SupervisionChoice,
  tmuxInstallFailure,
} from "../lib/wizard-state";
import { CopyButton } from "./copy-button";
import { FailureBody, ProgressView } from "./setup-screen";
import { StatusDetails } from "./status-details";
import { problemUnderTmuxFailure, TmuxFailureBlock } from "./tmux-screen";

/**
 * The tmux warning: the reason the buttons are gated, and the way out.
 *
 * The old page built one per caller (a factory, because two sections rendered
 * at once); a React component is the same guarantee — the element and its
 * flash slot are one instance for one caller, and a factory re-created per
 * render would throw away a half-finished Copy.
 */
export function TmuxWarning(props: {
  plan: ReturnType<typeof tmuxInstallPlan>;
  /** The install press. NOT disabled while busy: reading the docs and copying
   * the fix are most apt precisely while something else is in flight. */
  onInstall: () => void;
  onFail: (err: unknown) => void;
}): ReactElement {
  const plan = props.plan;
  const command = plan.command.join(" ");
  return (
    <div className="tmux-warning">
      {/* Names the whole gate, not just the server verbs: a disabled button whose
          reason the sentence does not name is the drift this line once was. */}
      <p>
        {"tmux was not found on the login PATH. The server launches every pane through it, so the actions that "}
        {"run or configure the server are disabled until tmux is installed."}
      </p>
      <div className="tmux-warning-row">
        {/* Ahead of the command it acts on, when the plan says we can run it at
            all: a user who downloaded a GUI should not be sent to a terminal for
            the fix a button can perform. */}
        <Button type="button" hidden={plan.kind !== "run"} onClick={props.onInstall}>
          {plan.label}
        </Button>
        {/* The command line follows the plan rather than a UA guess: on a Mac
            without Homebrew there is no button, so this line IS the fix, and the
            plan's MacPorts alternative is the honest thing to show. An empty
            command (a platform with nothing installable) hides the code and its
            Copy rather than showing "tmux" as a fix it is not. */}
        <code hidden={plan.command.length === 0}>{command}</code>
        {/* Copies what is SHOWN, so the code line and the clipboard cannot disagree.
            A fixed flash key rather than the command: this warning re-renders with
            every plan, and keying on the text would move the slot mid-flash the
            first time a plan changed. */}
        <span hidden={plan.command.length === 0}>
          <CopyButton getText={() => command} copyKey="tmux-install" label="install command" />
        </span>
        {/* Reading, not running: the no-Homebrew plan needs somewhere to go. A
            button calling a Rust command that holds the URL itself, so no URL is a
            value that crosses the IPC boundary — the same rule `desktop_open_path`
            follows. Not disabled while busy, which is what this and Copy both
            want. */}
        <Button
          type="button"
          variant="outline"
          hidden={!plan.docsUrl}
          onClick={() => void ipc.openTmuxDocs().catch(props.onFail)}
        >
          Read the docs
        </Button>
      </div>
    </div>
  );
}

export function StatusScreen(props: {
  strings: AssistantStrings;
  entranceKey?: number;
  probe: Probe;
  busy: boolean;
  running: boolean;
  failure: ActionResult | null;
  form: FormValues;
  supervision: SupervisionChoice;
  /** The tmux install's own answer, and the disclosure state the screens share. */
  tmuxResult: ActionResult | null;
  outputOpen: boolean;
  onOutputOpenChange: (open: boolean) => void;
  outputScroll: number;
  onOutputScroll: (scrollTop: number) => void;
  problem: string;
  detailsOpen: boolean;
  onDetailsOpenChange: (open: boolean) => void;
  onDetailsToggle: (open: boolean) => void;
  lastResult: ActionResult | null;
  lastTail: LogTail | null;
  about: About | null;
  onAction: (kind: RecoveryActionKind) => void;
  onInstallTmux: () => void;
  onGo: (to: ScreenId) => void;
  onOpenReset: () => void;
  onReveal: (target: OpenTarget) => void;
  onFail: (err: unknown) => void;
}): ReactElement {
  const { probe, busy, running, failure } = props;
  if (running) {
    return (
      <Frame strings={props.strings} entranceKey={props.entranceKey}>
        <ProgressView probe={probe} form={props.form} supervision={props.supervision} />
      </Frame>
    );
  }
  if (failure) {
    return (
      <Frame
        strings={props.strings}
        entranceKey={props.entranceKey}
        barRight={
          <Button type="button" disabled={busy || running} onClick={() => props.onAction("setup")}>
            Try Again
          </Button>
        }
      >
        <FailureBody
          probe={probe}
          form={props.form}
          supervision={props.supervision}
          failure={failure}
          detailsOpen={props.detailsOpen}
          onDetailsOpenChange={props.onDetailsOpenChange}
        />
      </Frame>
    );
  }

  const action = recoveryAction(probe.next);
  const tmuxMissing = probe.tmux === null;
  const failedHere = tmuxInstallFailure(props.tmuxResult, probe.tmux !== null);
  // The problem line is suppressed only where the card that owns the story
  // actually renders: the tmux-missing branch with a verdict in hand. A stale
  // tmuxResult beside a tmux that has since appeared renders no card, so the
  // line — whatever wrote it — stays.
  const shownProblem =
    tmuxMissing && failedHere !== null ? problemUnderTmuxFailure(props.problem, props.tmuxResult) : props.problem;
  return (
    <Frame
      strings={{ ...props.strings, problem: shownProblem }}
      entranceKey={props.entranceKey}
      barLeft={
        /* The ellipsis stays: it correctly says a screen follows rather than an act. */
        <Button type="button" variant="ghost" disabled={busy || running} onClick={props.onOpenReset}>
          {`${RESET_LABEL}…`}
        </Button>
      }
    >
      {action && (
        /* The old `button()` helper OR'd `busy || running` into every disabled
           state, and this one keeps it: a press during an act is a no-op, and
           the button must not look live. The CLI refuses `init` and `service
           install` without tmux, so a button that could only produce the
           refusal is disabled for that reason too — the warning below names
           it. Retry and Choose are not gated — neither runs a pane. */
        <Button
          type="button"
          className="w-full"
          disabled={busy || running || (tmuxMissing && action.kind !== "retry" && action.kind !== "choose-binary")}
          onClick={() => props.onAction(action.kind)}
        >
          {action.label}
        </Button>
      )}
      {tmuxMissing && (
        <>
          <TmuxWarning
            plan={tmuxInstallPlan(probe.platform, probe.hasBrew)}
            onInstall={props.onInstallTmux}
            onFail={props.onFail}
          />
          {/* THIS screen can run the install too — the warning's button goes through
              the same `startTmuxInstall` — so it owes the same answer. Without this
              the recovery screen runs an install and then says either one fragment
              of stderr on the problem line or, for a run that exits zero and changes
              nothing, nothing at all. */}
          {failedHere !== null && (
            <TmuxFailureBlock
              failure={failedHere}
              outputOpen={props.outputOpen}
              onOutputOpenChange={props.onOutputOpenChange}
              onScroll={props.onOutputScroll}
              restoreScrollTo={props.outputScroll}
            />
          )}
        </>
      )}
      {/* The secondary doors, one per row — the update link rides the same stack,
          because it names a screen, not an act. Reachable HERE as well as from the
          dashboard, and that is the point: a machine whose service definition is
          broken has no dashboard to open the door from. */}
      <div className="recovery-links">
        {probe.serverChoice === "upgrade-available" && (
          <button
            type="button"
            className="rounded-sm text-body text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            disabled={busy || running}
            onClick={() => props.onGo("update")}
          >
            {`Update Server to ${probe.bundledVersion}…`}
          </button>
        )}
        <button
          type="button"
          className="rounded-sm text-body text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          disabled={busy || running}
          onClick={() => props.onGo("supervision")}
        >
          Change how it runs…
        </button>
        {/* Also reachable here, for the same reason: the dashboard is the ordinary
            door to updating and a machine on this screen has no dashboard. Always
            offered rather than gated on a known update — nothing on THIS page knows
            whether one exists until the screen behind it asks, and a row that
            appeared only after an answer nobody had asked for would mean checking
            on the poll. */}
        <button
          type="button"
          className="rounded-sm text-body text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          disabled={busy || running}
          onClick={() => props.onGo("update")}
        >
          Check for updates…
        </button>
        {/* A wrong port or bind address is one of the few things that puts a machine
            here. The tray carries the same door for the case this screen never
            renders — a server that answers but will not accept a sign-in. */}
        <button
          type="button"
          className="rounded-sm text-body text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          disabled={busy || running}
          onClick={() => props.onGo("settings")}
        >
          Server Addresses…
        </button>
      </div>
      <StatusDetails
        probe={probe}
        lastResult={props.lastResult}
        lastTail={props.lastTail}
        about={props.about}
        open={props.detailsOpen}
        onOpenChange={props.onDetailsToggle}
        onReveal={props.onReveal}
      />
    </Frame>
  );
}
