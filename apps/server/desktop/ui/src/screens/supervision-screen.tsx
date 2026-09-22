/**
 * **How Your Server Runs** (spec 2026-09-21; plan Task 6) — the port of
 * `renderSupervision`.
 *
 * Reached from the recovery screen's doors and the SPA's service card, and it
 * changes exactly one thing: who starts the server, and when. The pending
 * choice is PAGE state (`supervisionForm`, cleared on the way out by
 * `applyScreen` and `host.close()`), because a radio read from the probe alone
 * would undo the person's selection before they reached Apply.
 */
import { type AssistantStrings, Frame } from "@internal/assistant";
import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { ActionResult, Probe } from "../lib/ipc";
import {
  applySupervisionChoice,
  autostartSupported,
  leaveLabel,
  MIN_AUTOSTART_SERVER_VERSION,
  type SupervisionChoice,
} from "../lib/wizard-state";

/** A result's own words, as the old `renderOutput` built them — or nothing. */
function outputOf(result: ActionResult | null): { text: string; failed: boolean } | null {
  const parts: string[] = [];
  if (result?.stdout?.trim()) parts.push(result.stdout.trim());
  if (result?.stderr?.trim()) parts.push(result.stderr.trim());
  if (parts.length === 0) return null;
  return { text: parts.join("\n\n"), failed: result?.ok === false };
}

export function SupervisionScreen(props: {
  /** The rail node the host computed for this route, or undefined when the route is full-window. */
  rail?: ReactElement;
  strings: AssistantStrings;
  entranceKey?: number;
  probe: Probe;
  busy: boolean;
  running: boolean;
  failure: ActionResult | null;
  /** The screen's pending choice, or null while it is still the machine's own answer. */
  supervisionForm: SupervisionChoice | null;
  onChoice: (next: SupervisionChoice) => void;
  onApply: (chosen: SupervisionChoice) => void;
  onClose: () => void;
}): ReactElement {
  const { probe, busy, running } = props;
  const chosen = props.supervisionForm ?? {
    background: probe.supervision !== "app",
    autostart: probe.service?.enabled === true,
  };

  const option = (opts: { id: string; on: boolean; title: string; body: string; onPick: () => void }): ReactElement => (
    <label className="choice-row" htmlFor={opts.id}>
      <input
        type="radio"
        name="supervision-mode"
        id={opts.id}
        checked={opts.on}
        disabled={busy || running}
        onChange={opts.onPick}
      />
      <div>
        <div className="label">{opts.title}</div>
        <div className="hint">{opts.body}</div>
      </div>
    </label>
  );

  // The CLI's own words where the person still is, styled as a failure — the
  // same treatment the reset screen's half-run log gets, so two surfaces never
  // phrase one outcome differently.
  const out = outputOf(props.failure);
  const current = { background: probe.supervision !== "app", autostart: probe.service?.enabled === true };
  const unchanged = current.background === chosen.background && current.autostart === chosen.autostart;
  return (
    <Frame
      rail={props.rail}
      strings={props.strings}
      entranceKey={props.entranceKey}
      // The rail is the navigation now (operator ruling 2026-09-22): selecting
      // another section leaves, so a leave button beside it is chrome answering
      // a question the rail already answers. It stays ONLY where the rail is
      // not — a requested screen rendered over a mid-first-run machine has no
      // rail, and there this is still the only way out.
      barLeft={
        props.rail === undefined && (
          <Button type="button" variant="ghost" disabled={busy || running} onClick={props.onClose}>
            {leaveLabel(probe, probe.onboarded)}
          </Button>
        )
      }
      barRight={
        <Button type="button" disabled={unchanged || busy || running} onClick={() => props.onApply(chosen)}>
          Apply
        </Button>
      }
    >
      {/* The live state, said ONCE, above the choice it describes (operator
          ruling 2026-09-22, the delta review): "Currently" keys on the
          machine, never on the draft. This screen gates its choice behind
          Apply, and a sentence that followed the draft would call an
          unapplied pick the present tense. The option rows below answer a
          different question — what picking this one DOES — so they stay in
          option voice. */}
      <p className="hint">
        {!current.background
          ? "Currently the Subshell Server Service runs with this app."
          : current.autostart
            ? "Currently the Subshell Server Service runs in the background, and starts automatically on startup."
            : "Currently the Subshell Server Service runs in the background, but does not automatically start on startup."}
      </p>
      {option({
        id: "sup-service",
        on: chosen.background,
        title: "In the background",
        body: "Runs as a service the machine starts, and brings back when it stops.",
        onPick: () => props.onChoice(applySupervisionChoice(chosen, { background: true })),
      })}
      {/* Nested under the option it belongs to, and only live while that option is
          the one selected — arming login means nothing without a service. */}
      <div className="choice-sub">
        <Switch
          id="sup-login"
          checked={chosen.autostart && autostartSupported(probe)}
          disabled={!chosen.background || !autostartSupported(probe) || busy || running}
          onCheckedChange={(checked) => props.onChoice(applySupervisionChoice(chosen, { autostart: checked }))}
        />
        <Label htmlFor="sup-login">Start automatically on startup</Label>
        {chosen.background && autostartSupported(probe) && (
          <span className="hint">
            {chosen.autostart
              ? "Turning this off leaves it running in the background, but it will not start again after a startup."
              : "Turning this on starts it automatically every time the machine starts."}
          </span>
        )}
        {!autostartSupported(probe) && (
          <span className="hint">{`Update your server to ${MIN_AUTOSTART_SERVER_VERSION} to control this.`}</span>
        )}
      </div>
      {option({
        id: "sup-app",
        on: !chosen.background,
        title: "With this app",
        body: "Runs while Subshell Server is open; quitting stops it. Running subshells keep running.",
        onPick: () => props.onChoice(applySupervisionChoice(chosen, { background: false })),
      })}
      {out && <pre className={out.failed ? "output output-bad" : "output"}>{out.text}</pre>}
    </Frame>
  );
}
