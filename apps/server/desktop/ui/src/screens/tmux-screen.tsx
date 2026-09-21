/**
 * The tmux screen (spec 2026-09-21; plan Task 3) — the port of `renderTmux`,
 * `installProgress`, `tmuxFailureBlock`, `manualCommand` and
 * `manualRouteSteps`.
 *
 * The one stop on the zero-touch first run (spec 2026-09-17 D2) — and it is
 * only ever reached with tmux MISSING, one Continue past the welcome.
 * `screensFor` puts this screen on the list exactly while `probe.tmux` is
 * null, so there is no "already installed" state to render and no Continue to
 * press: the moment the poll sees a tmux, the list stops containing this
 * screen, the route re-resolves PAST the already-pressed welcome to `setup`,
 * and the chain fires itself. That advance is the whole point — the screen
 * that used to be shown on every first run needed the Continue its now-gone
 * found-state carried; this one leaves by itself.
 *
 * **Screen-local state.** `manualRoute` (which manager's instructions are
 * showing) lives here now: the old page held it at page level only because a
 * poll-driven DOM rebuild destroyed component memory, and that reason is
 * gone. `tmuxOutputOpen`/`tmuxOutputScroll` stay HOST state — the failure
 * block below is rendered here AND by the recovery screen, so the disclosure
 * is one fact about the install, not about either screen.
 */
import { type AssistantStrings, Frame } from "@internal/assistant";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { type ManualRoute, manualTmuxRoutes, tmuxInstallPlan } from "../lib/installers";
import type { ActionResult, Probe } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import { failureLine, lastLine, prereqState, type TmuxInstallFailure, tmuxInstallFailure } from "../lib/wizard-state";
import { CopyButton } from "./copy-button";

/**
 * `m:ss` since the install began, as the old `elapsed` computed it.
 */
export function elapsed(sinceMs: number, now: number): string {
  const total = Math.max(0, Math.round((now - sinceMs) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The install clock — the old `startInstallClock`'s 1 s repaint, as a hook.
 *
 * Its own timer because the ordinary poll returns early while `busy`,
 * deliberately — a refresh under a running action is what it exists to avoid.
 * So during the one action whose screen has to keep moving, nothing was
 * repainting it at all. Here the tick re-renders THIS screen only, which is
 * the one thing the clock moves.
 */
function useInstallClock(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
}

/**
 * Why the failure block owns the problem line.
 *
 * The shared problem line said a tmux failure once, in one sentence taken
 * from whatever the manager's stderr happened to end on. The card is that
 * failure said properly, so the line is cleared rather than reporting it
 * twice in two different wordings.
 *
 * Only when the line IS this failure, though. `refresh` puts `probe.error`
 * there over the top of an action's message, and a card about a package
 * manager is no reason to hide a machine that cannot be read at all.
 *
 * `lastLine(problem)` rather than `problem`, because the two paths put
 * different shapes there: a non-ok result gives `failureLine`'s single
 * trimmed line, while a REJECTION gives `errText(err)` whole — untrimmed and
 * possibly multi-line. Compared exactly, a multi-line Rust error left the
 * same failure reported twice, which is the duplication this prevents.
 *
 * Both screens that render the card owe the same rule — the tmux screen and
 * the recovery screen — so it lives beside the card instead of at either
 * call site.
 */
export function problemUnderTmuxFailure(problem: string, tmuxResult: ActionResult | null): string {
  if (tmuxResult !== null && lastLine(problem) === failureLine(tmuxResult)) return "";
  return problem;
}

/** What an install that did not work says for itself (operator's report, 2026-09-18). */
export function TmuxFailureBlock(props: {
  failure: TmuxInstallFailure;
  /** The disclosure's openness — host state, shared with the recovery screen. */
  outputOpen: boolean;
  onOutputOpenChange: (open: boolean) => void;
  onScroll: (scrollTop: number) => void;
  restoreScrollTo: number;
}): ReactElement {
  const failure = props.failure;
  return (
    <div className="install-failure">
      <p className="label">{failure.headline}</p>
      {/* Empty is a real answer — a spawn that never ran says nothing at all — and an
          empty line under the headline would be a gap the eye reads as a missing explanation. */}
      {failure.line !== "" && <p className="install-line">{failure.line}</p>}
      {failure.output !== "" && (
        <details
          open={props.outputOpen}
          onToggle={(e) => props.onOutputOpenChange((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary>Show output</summary>
          {/* The same treatment the recovery screen's failed action and the reset
              screen's half-run log get, so three surfaces never phrase one outcome
              three ways. The offset is restored on mount, which is the only point
              at which the element has a scroll height to be offset within. */}
          <TmuxOutputPane text={failure.output} onScroll={props.onScroll} restoreTo={props.restoreScrollTo} />
        </details>
      )}
    </div>
  );
}

/** The failure output's `<pre>`, with the reader's scroll offset preserved across re-renders. */
function TmuxOutputPane(props: {
  text: string;
  onScroll: (scrollTop: number) => void;
  restoreTo: number;
}): ReactElement {
  const ref = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    // Restored after the element is in the document, which is the only point
    // at which it has a scroll height to be offset within — assigning before
    // the append silently does nothing.
    if (ref.current !== null) ref.current.scrollTop = props.restoreTo;
  });
  return (
    <pre ref={ref} className="pane-pre output-bad" onScroll={(e) => props.onScroll(e.currentTarget.scrollTop)}>
      {props.text}
    </pre>
  );
}

/** The install's own progress: a spinner, a clock, and the package manager's last line. */
function InstallProgress(props: { installLine: string; startedAt: number; now: number }): ReactElement {
  return (
    <div className="install-progress">
      <p className="install-head">
        <span className="install-spinner" aria-hidden="true" />
        <span className="label">Installing tmux…</span>
        {/* The stamp lands after the presence check the install runs first, so the
            pane's first frames have none. Counting from the epoch would print a
            five-figure clock for a moment, which is the sort of thing that gets
            screenshotted. */}
        <span className="detail">{elapsed(props.startedAt === 0 ? props.now : props.startedAt, props.now)}</span>
      </p>
      {/* `aria-live="polite"`, so a screen reader hears the manager's own words as
          they change rather than nothing at all for ten minutes. */}
      <p className="install-line" aria-live="polite">
        {props.installLine || "Starting the package manager…"}
      </p>
    </div>
  );
}

/** One manager's instructions, shown after its button is pressed. */
export function ManualRouteSteps(props: { route: ManualRoute; onFail: (err: unknown) => void }): ReactElement {
  const route = props.route;
  return (
    <div className="manual-steps">
      {/* Each line has to SAY where it leads — "Don't have Homebrew?" over a button
          that opens a website answers a question with a dead end. So the first line
          says what the site is for and that you come back, and the second says what
          you can do once you have. */}
      <p className="hint">{`Don't have ${route.name}? Install it from its site, then come back.`}</p>
      {/* A MEMBER of the closed URL set, never the address: Rust owns every page
          this app can open (see `WebTarget`). */}
      <button type="button" onClick={() => void ipc.openWeb(route.target).catch(props.onFail)}>
        {`Open ${route.name} site`}
      </button>
      <p className="hint">{`Once you have ${route.name}, run:`}</p>
      <div className="manual-command">
        <span className="code-line">{route.command}</span>
        {/* The command is the flash slot: one route's tick must not appear on the other's button. */}
        <CopyButton getText={() => route.command} copyKey={route.command} label={`the ${route.name} command`} />
      </div>
    </div>
  );
}

export function TmuxScreen(props: {
  strings: AssistantStrings;
  probe: Probe;
  busy: boolean;
  running: boolean;
  /** The tmux install's own last answer, or null when none has run in this window. */
  tmuxResult: ActionResult | null;
  /** The disclosure state the two screens that show the failure block share. */
  outputOpen: boolean;
  onOutputOpenChange: (open: boolean) => void;
  outputScroll: number;
  onOutputScroll: (scrollTop: number) => void;
  /** The package manager's last output line, and when the install began. */
  installLine: string;
  installStartedAt: number;
  problem: string;
  onInstall: () => void;
  onFail: (err: unknown) => void;
  /** The host's screen-change epoch, for the entrance animation. */
  entranceKey?: number;
}): ReactElement {
  const { probe, busy, running, tmuxResult, problem, installLine, installStartedAt } = props;
  // Which manager's manual instructions are showing, or null for none yet.
  // Screen-local state: the old page held it at page level only because a
  // poll-driven DOM rebuild destroyed component memory, and that reason is
  // gone. Leaving the screen forgets it, which is what a fresh visit wants.
  const [manualRoute, setManualRoute] = useState<ManualRoute["target"] | null>(null);
  const plan = tmuxInstallPlan(probe.platform, probe.hasBrew);
  const failed = tmuxInstallFailure(tmuxResult, probe.tmux !== null);
  // The screen's own problem line: the failure card replaces it when the line
  // IS this failure (see `problemUnderTmuxFailure`).
  const strings: AssistantStrings = {
    ...props.strings,
    problem: problemUnderTmuxFailure(problem, tmuxResult),
  };
  // The 1 s repaint that keeps the clock moving while the poll is held off.
  useInstallClock(installStartedAt !== 0);
  const now = Date.now();

  let content: ReactElement;
  if (prereqState(probe) === "install" && plan.kind === "run") {
    if (busy) {
      content = <InstallProgress installLine={installLine} startedAt={installStartedAt} now={now} />;
    } else {
      content = (
        <>
          {/* It says it here now, in the app's own words, next to the manager's, above
              the button that looked exactly as it had before the press. */}
          {failed !== null && (
            <TmuxFailureBlock
              failure={failed}
              outputOpen={props.outputOpen}
              onOutputOpenChange={props.onOutputOpenChange}
              onScroll={props.onOutputScroll}
              restoreScrollTo={props.outputScroll}
            />
          )}
          {/* "Try again", because pressing a button labelled with the act that just
              failed asks the reader to believe the same press will do something
              different this time. It will — it re-reads the machine first — and the
              label is where that is said. */}
          <button type="button" className="primary big" disabled={busy || running} onClick={props.onInstall}>
            {failed === null ? plan.label : "Try again"}
          </button>
          {/* Centred under a full-width button: left-aligned, it read as a caption for
              the screen's left edge rather than for the button it belongs to. */}
          <p className="hint centered">Your package manager may ask for your password.</p>
          {/* Only once the button has been shown not to work. Printing the line up
              front asks someone to paste an unexplained command on a window's say-so
              while a button that does it for them sits above it. */}
          {failed !== null && <ManualCommand command={plan.command.join(" ")} />}
        </>
      );
    }
  } else {
    const routes = manualTmuxRoutes(probe.platform);
    content = (
      <>
        {/* ABOVE the instructions, not under them. The screen is already polling, so
            it WILL notice tmux the moment it appears — but a person who has gone off
            to a terminal and come back reads the top of the pane first, and a window
            that says nothing about watching looks frozen. */}
        <p className="tmux-checking">
          <span className="glyph" />
          <span className="label">Checking for tmux…</span>
        </p>
        {routes.length === 0 ? (
          <>
            {/* A platform this app does not ship to: the reading link is the whole
                honest answer. Naming a command here would be a guess in the one place
                the reader cannot check it. */}
            <p className="hint">This machine has no package manager this app can drive. In a terminal:</p>
            {plan.command.length > 0 && <span className="code-line">{plan.command.join(" ")}</span>}
            {plan.docsUrl !== "" && (
              <button type="button" className="ghost" onClick={() => void ipc.openTmuxDocs().catch(props.onFail)}>
                Read the tmux docs
              </button>
            )}
          </>
        ) : (
          <>
            {/* What to DO, not what this machine lacks. Running text introducing the two
                buttons takes the body role rather than the detail one this screen's
                asides use, centred under a centred title. */}
            <p className="wizard-copy centered">Installing tmux through Homebrew or MacPorts is recommended.</p>
            {/* Two ordinary buttons, side by side: no class, so they carry the app's
                default button look rather than the ghost one. Pressing one REVEALS that
                manager's instructions below; nothing is shown until asked for. */}
            <div className="manual-routes">
              {routes.map((route) => (
                <button
                  key={route.target}
                  type="button"
                  id={`route-${route.target}`}
                  aria-pressed={manualRoute === route.target}
                  onClick={() => setManualRoute(manualRoute === route.target ? null : route.target)}
                >
                  {route.name}
                </button>
              ))}
            </div>
            {routes
              .filter((route) => route.target === manualRoute)
              .map((route) => (
                <ManualRouteSteps key={route.target} route={route} onFail={props.onFail} />
              ))}
          </>
        )}
      </>
    );
  }

  return (
    <Frame
      strings={strings}
      entranceKey={props.entranceKey}
      // NO bar, and that is structural rather than spare: there is nowhere to go
      // BACK to (this is the first screen a first run shows), and no CONTINUE to
      // press — the screen leaves the moment tmux exists.
    >
      {content}
    </Frame>
  );
}

/** The one line a person can paste, with its Copy. */
function ManualCommand(props: { command: string }): ReactElement {
  return (
    <div className="manual-steps">
      <p className="hint">Or run this in a terminal:</p>
      <div className="manual-command">
        <span className="code-line">{props.command}</span>
        {/* A fixed flash key rather than the command's own text: keying on a string
            that can change with the platform would move the slot mid-flash. */}
        <CopyButton getText={() => props.command} copyKey="tmux-manual" label="the install command" />
      </div>
    </div>
  );
}
