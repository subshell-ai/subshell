/**
 * The Set Up screen and its two variants (spec 2026-09-21; plan Task 3) — the
 * port of `renderSetup`, `renderProgress`, `checklist`, `renderFailure`,
 * `supervisionGroup` and `dashboardLine`.
 *
 * The screen is THREE states of one act, exactly as the old render function
 * branched: the progress checklist while the chain runs, the failure view
 * when the chain stopped short, and the question itself. Both the variants
 * and the checklist are exported, because `renderRecovery` called the same
 * two functions — the recovery screen renders them through these exports
 * rather than through a second copy.
 *
 * **The auto-fire.** The ordinary first run never shows this screen's
 * question: the chain fires itself and the progress checklist is what follows
 * the intro. That this screen is not rendered under Welcome is the fire's
 * gate — the welcome press is what lets the machine be touched at all. Two
 * things must be true before the fire that the pure decision cannot see, and
 * both belong to the screen rather than to `autoSetupDecision`:
 *
 * - the port answer must be IN. The check is a round trip and the decision
 *   treats "unknown" as free (that is what keeps a Set Up button from dying
 *   for a beat per keystroke), but firing on an unmeasured port would send a
 *   machine whose port is busy into a failed chain when § 4.3 wants it the
 *   pre-filled form with the conflict warning. The ask is an effect (the old
 *   render fired it as a render side effect, which a React render may not
 *   do); the answer's arrival re-renders, and that re-render's effect is
 *   where the fire happens.
 * - `autoFired` must be clear — one fire per load. A failure is NOT re-fired
 *   (the failure branch renders first); the human presses Try Again, because
 *   a chain that already failed once and re-runs itself twice a second is the
 *   bug, not the feature. The probe gets a new identity every 1500 ms, so the
 *   latch is what keeps a live probe from re-firing the chain.
 *
 * The fire runs in a LAYOUT effect: the old fire rendered the progress screen
 * synchronously before the form could paint, and a passive effect would let
 * one frame of the question flash first.
 */
import { type AssistantStrings, Frame } from "@internal/assistant";
import { type ReactElement, useLayoutEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { dashboardUrl, type ExplicitMap, type FormName, type FormValues } from "../lib/config-form";
import type { ActionResult, Probe, SettingEntry } from "../lib/ipc";
import {
  applySupervisionChoice,
  autoSetupDecision,
  autostartSupported,
  canSetup,
  checklistAddresses,
  failureLine,
  type SetupRow,
  type SupervisionChoice,
  setupRows,
  supervisionLoginReason,
} from "../lib/wizard-state";
import { AddressFields, chosenPort } from "./address-fields";

/**
 * The five-row checklist; the first not-done row takes `undoneState`.
 */
export function Checklist(props: {
  probe: Probe;
  form: FormValues;
  supervision: SupervisionChoice;
  undoneState: "active" | "failed";
  failure: ActionResult | null;
}): ReactElement {
  // NOT `form.port`/`form.host` raw: on the auto-fired chain the form never
  // rendered, and the row would read "port 3080" off a machine the chain just
  // left on its stored 4000 — under a subtitle vouching for the list.
  const rows: SetupRow[] = setupRows(props.probe, checklistAddresses(props.probe, props.form), props.supervision);
  const first = rows.find((r) => !r.done);
  return (
    <ul className="checklist">
      {rows.map((row) => {
        const isFailedRow = !row.done && row === first && props.undoneState === "failed";
        return (
          <li key={row.id} data-state={row.done ? "done" : row === first ? props.undoneState : "pending"}>
            <span className="glyph">{row.done ? "✓" : isFailedRow ? "✕" : ""}</span>
            <span className="label">{row.label}</span>
            <span className="detail">{row.detail}</span>
            {isFailedRow && props.failure && <div className="sub">{failureLine(props.failure)}</div>}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The failed chain's body — the checklist with the failing row marked, and
 * the run's own words behind Show Details. Shared by the setup screen and the
 * recovery screen, which both rendered it through the old `renderFailure`;
 * the Try Again button stays with each screen's bar, where the old function
 * put it.
 */
export function FailureBody(props: {
  probe: Probe;
  form: FormValues;
  supervision: SupervisionChoice;
  failure: ActionResult | null;
  detailsOpen: boolean;
  onDetailsOpenChange: (open: boolean) => void;
}): ReactElement {
  return (
    <>
      <Checklist
        probe={props.probe}
        form={props.form}
        supervision={props.supervision}
        undoneState="failed"
        failure={props.failure}
      />
      {props.failure && (
        <details open={props.detailsOpen} onToggle={(e) => props.onDetailsOpenChange(e.currentTarget.open)}>
          {/* The openness is PAGE state (host state here), for the same reason the
              recovery screen's is: the poll re-renders, and a `<details>` whose
              openness lived only in the DOM collapsed under the reader. It did
              exactly that until now. */}
          <summary>Show Details</summary>
          <pre className="pane-pre output-bad">
            {[props.failure.stdout.trim(), props.failure.stderr.trim()].filter(Boolean).join("\n\n")}
          </pre>
        </details>
      )}
      {/* "Open Status Page" used to be here and on the ready screen, opening the
          console. There is no second window to offer: this page IS the status
          page now, and a failed chain leaves the reader on the screen that
          explains it (spec 2026-09-12 § 5.1). */}
    </>
  );
}

/** The progress checklist, mid-chain. */
export function ProgressView(props: { probe: Probe; form: FormValues; supervision: SupervisionChoice }): ReactElement {
  return (
    <Checklist
      probe={props.probe}
      form={props.form}
      supervision={props.supervision}
      undoneState="active"
      failure={null}
    />
  );
}

/**
 * The address the dashboard will run at — the Set Up screen's first row.
 *
 * It wears the checklist row's shape (label left, value right) because a URL
 * is a value. What it says is `dashboardUrlValue`'s three steps, computed per
 * render: a React re-render is reconciliation, so the old "re-text the row in
 * place" mirror needs no counterpart — the row follows the typing on its own.
 */
export function DashboardLine(props: { value: string }): ReactElement {
  return (
    <div className="dashboard-url">
      <span className="label">Dashboard URL</span>
      <span className="detail">{props.value}</span>
    </div>
  );
}

/**
 * The supervision question — the whole content of the Set Up screen.
 *
 * `apps/server/web`'s supervision card is the shape this follows; see the
 * radio/login split there and in `lib/supervision.ts`. The manager's name
 * goes in the SENTENCE, where it explains something, rather than in the title
 * as a parenthetical that explains nothing.
 */
export function SupervisionGroup(props: {
  probe: Probe;
  supervision: SupervisionChoice;
  locked: boolean;
  onChoice: (next: SupervisionChoice) => void;
}): ReactElement {
  const { probe, supervision, locked } = props;
  const mode = (opts: { id: string; background: boolean; title: string; body: string }): ReactElement => (
    <label className="supervision-mode">
      <input
        type="radio"
        name="plan-supervision"
        id={opts.id}
        checked={supervision.background === opts.background}
        disabled={locked}
        onChange={() => props.onChoice(applySupervisionChoice(supervision, { background: opts.background }))}
      />
      <span className="supervision-copy">
        <span className="label">{opts.title}</span>
        <span className="detail">{opts.body}</span>
      </span>
    </label>
  );

  const reason = supervisionLoginReason(probe, supervision);
  return (
    <section className="supervision">
      <div className="supervision-modes" role="radiogroup" aria-label="How this server runs">
        {mode({
          id: "plan-mode-service",
          background: true,
          title: "In the background",
          body: "The Subshell Server Service runs in the background and comes back if it stops.",
        })}
        {mode({
          id: "plan-mode-app",
          background: false,
          title: "With the Subshell Server app",
          // The dashboard's sentence, plus the reassurance only this screen is in
          // a position to give: the panes are not the server, and someone choosing
          // app mode is being told the app can stop it.
          body: "Runs while the app is open; quitting the app stops it. Running subshells keep running.",
        })}
      </div>
      <div className="supervision-login">
        <Switch
          id="plan-autostart"
          checked={supervision.autostart && autostartSupported(probe)}
          disabled={reason !== null || locked}
          onCheckedChange={(checked) => props.onChoice(applySupervisionChoice(supervision, { autostart: checked }))}
        />
        <span className="supervision-copy">
          <Label htmlFor="plan-autostart">Start at login</Label>
          <span className="detail">
            {reason ??
              "Starts the server again the next time you log in to this machine. Without it, the service runs now but nothing brings it back after you log out or restart."}
          </span>
        </span>
      </div>
    </section>
  );
}

/**
 * What the dashboard row says right now — the address a save would leave the
 * server answering on, in the same three steps `configure` takes: the base-URL
 * FIELD once the form holds one, else a STORED base URL but only one somebody
 * chose, else the derivation from `chosenPort`. (A cleared field over a
 * *chosen* stored value shows the stored one, and is honest: `baseUrl` is not
 * the emptyable flag, so that save omits it and the disk value survives.)
 */
export function dashboardUrlValue(form: FormValues, seeded: boolean, probe: Probe): string {
  const typed = seeded ? form.baseUrl : "";
  const setting = probe.status?.settings?.APP_BASE_URL;
  const stored = setting && setting.source !== "default" ? (setting.value ?? "") : "";
  return dashboardUrl(typed || stored, chosenPort(form, probe));
}

export function SetupScreen(props: {
  /** The rail node the host computed for this route, or undefined when the route is full-window. */
  rail?: ReactElement;
  strings: AssistantStrings;
  /** The host's screen-change epoch, for the entrance animation. */
  entranceKey?: number;
  probe: Probe;
  busy: boolean;
  running: boolean;
  failure: ActionResult | null;
  /** Whether the chain has already fired itself this window load. */
  autoFired: boolean;
  onAutoFire: () => void;
  /** The port check's cached answer, and the ask. */
  portCheck: { port: string; inUse: boolean } | null;
  onCheckPort: (port: string) => void;
  form: FormValues;
  explicit: ExplicitMap;
  supervision: SupervisionChoice;
  onSupervision: (next: SupervisionChoice) => void;
  customizeOpen: boolean;
  onCustomizeToggle: () => void;
  seeded: boolean;
  onFormEdit: (name: FormName, values: FormValues, explicit: ExplicitMap) => void;
  onStartSetup: () => void;
  onPickBinary: () => void;
  settings: Record<string, SettingEntry> | undefined;
  detailsOpen: boolean;
  onDetailsOpenChange: (open: boolean) => void;
}): ReactElement {
  const { probe, busy, running, failure } = props;

  // --- Auto-fire (spec 2026-09-17 § 4.2). ---------------------------------
  // The port the chain would bind, as the old render's `portConflict` read
  // it, and the two effects that decide whether the chain fires. BOTH run
  // before the branch below, because hooks may not sit behind an early
  // return — and the guards inside them are what keep the branches from
  // mattering.
  const port = chosenPort(props.form, probe);
  const portKnown = props.portCheck !== null && props.portCheck.port === port;
  const conflict = props.portCheck !== null && props.portCheck.port === port && props.portCheck.inUse ? { port } : null;

  // Ask about the port this screen would bind, once per (form, probe) change.
  // The old render called `portConflict` — a side effect — every render; the
  // ask-once and supersede rules live inside the check hook.
  useLayoutEffect(() => {
    props.onCheckPort(chosenPort(props.form, probe));
  }, [props.form.port, probe, props.onCheckPort, props.form]);

  // Layout effect: the old fire rendered the progress screen synchronously,
  // before the question could paint. A passive effect would let one frame of
  // the form flash first.
  useLayoutEffect(() => {
    if (props.autoFired || running || failure !== null) return;
    if (!portKnown) return;
    // `busy || running` is what the page folds into the decision; the runner
    // guards again, because a decision is not a lock.
    const decision = autoSetupDecision(probe, conflict, busy || running);
    if (decision.mode !== "fire") return;
    props.onAutoFire();
  }, [props.autoFired, portKnown, conflict, busy, running, failure, probe, props.onAutoFire]);

  if (running) {
    return (
      <Frame rail={props.rail} strings={props.strings} entranceKey={props.entranceKey}>
        <ProgressView probe={probe} form={props.form} supervision={props.supervision} />
      </Frame>
    );
  }
  if (failure) {
    return (
      <Frame
        rail={props.rail}
        strings={props.strings}
        entranceKey={props.entranceKey}
        barRight={
          <Button type="button" disabled={busy || running} onClick={props.onStartSetup}>
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

  // Why Set Up is held back, and the two ways past it.
  const gate = canSetup(probe, busy, conflict);
  return (
    <Frame
      rail={props.rail}
      strings={props.strings}
      entranceKey={props.entranceKey}
      barRight={
        <>
          {/* The reason beside the button is four words, which is the right size for a
              button that is merely waiting and the wrong size for one that will not
              come back on its own. An empty reason means busy: a spinner is already
              on screen. */}
          {!gate.ok && gate.reason && <span className="reason">{gate.reason}</span>}
          <Button type="button" disabled={!gate.ok} onClick={props.onStartSetup}>
            Set Up
          </Button>
        </>
      }
    >
      <DashboardLine value={dashboardUrlValue(props.form, props.seeded, probe)} />
      {/* Above the question, not beside the button: it is the reason the screen
          cannot be completed, and a reader who starts at the top should meet it
          before choosing how a server they cannot start yet ought to run. */}
      {conflict && (
        <div className="port-warning mb-4">
          <p>{`Something is already answering on port ${conflict.port}.`}</p>
          <p>Stop whatever is using it, or choose a different port under “Customize port and addresses…”.</p>
        </div>
      )}
      <SupervisionGroup
        probe={probe}
        supervision={props.supervision}
        locked={busy || running}
        onChoice={props.onSupervision}
      />
      <div className="mt-4 flex gap-4">
        <button
          type="button"
          className="rounded-sm text-label underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          onClick={props.onCustomizeToggle}
        >
          {props.customizeOpen ? "Use defaults" : "Customize port and addresses…"}
        </button>
        {probe.serverChoice === "no-bundled" && (
          <button
            type="button"
            className="rounded-sm text-body text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            onClick={props.onPickBinary}
          >
            Choose an existing server…
          </button>
        )}
      </div>
      {props.customizeOpen && (
        <AddressFields
          values={props.form}
          explicit={props.explicit}
          settings={props.settings}
          onEdit={(edit) => {
            props.onFormEdit(edit.name, edit.values, edit.explicit);
            // Ask about a new number now rather than at the next render. The
            // poll skips a tick while a text field has focus, so without this
            // the answer for a port someone just typed would not start being
            // measured until they left the field — and the screen would keep
            // naming the old conflict while they looked at the fix.
            if (edit.name === "port") props.onCheckPort(chosenPort(edit.values, probe));
          }}
        />
      )}
      {/* No Back: this is the first screen a machine without tmux trouble ever
          shows, and the form is the whole screen, not a step with a step before
          it. The gate and button stay because the fallback path is walked by
          hand: whoever lands here because the port was busy fixes the port under
          Customize, and only they can say when the port is theirs to take. */}
    </Frame>
  );
}
