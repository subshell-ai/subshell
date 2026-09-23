/**
 * **How Your Server Runs** (spec 2026-09-21; plan Task 6) — the port of
 * `renderSupervision`.
 *
 * Reached from the recovery screen's doors and the SPA's service card, and it
 * changes exactly one thing: who starts the server, and when. The pending
 * choice is PAGE state (`supervisionForm`, cleared on the way out by
 * `applyScreen` and `host.close()`), because a radio read from the probe alone
 * would undo the person's selection before they reached Apply.
 *
 * **The launch row below it is NOT behind that Apply** (operator ruling
 * 2026-09-23). It is a different kind of act: writing one settings field whose
 * effect is felt at the next launch, with nothing on this machine to stop,
 * uninstall or restart. Apply exists because the modes above are a chain; a
 * choice that runs no chain saves on the press, and the row says so in the
 * sentence under it rather than leaving the reader to work out which button
 * carries it.
 */
import { type AssistantStrings, Frame } from "@internal/assistant";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { ActionResult, LaunchWindow, Probe } from "../lib/ipc";
import * as ipc from "../lib/ipc";
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

  // The launch preference is this screen's own read (operator ruling
  // 2026-09-23), not a probe field: it is a choice, and nothing outside this
  // app can change it under the window, so there is no tick to attach it to.
  // The initial value is the one Rust gives a settings file that never stored
  // one, so a read that has not landed yet already draws the right radio.
  const [launch, setLaunch] = useState<LaunchWindow>("dashboard");
  const [launchNote, setLaunchNote] = useState<string | null>(null);
  /**
   * Whether a press has landed since this screen opened.
   *
   * A press outranks the opening read rather than racing it. A fast pick can
   * beat the read home, and applying the stored answer afterwards would undo a
   * choice the person can see they just made — the defect the first version of
   * this row shipped with, caught by
   * `supervision-screen.test.tsx`'s "saves the moment the other window is
   * picked".
   */
  const picked = useRef(false);
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const stored = await ipc.launchWindow();
        if (alive && !picked.current) setLaunch(stored);
      } catch {
        // A row that cannot read the file still shows the behavior the machine
        // has, which is the dashboard, and says which of the two it is drawing.
        if (alive && !picked.current) {
          setLaunchNote("This app could not read the saved choice. The row shows the control plane.");
        }
      }
    };
    void read();
    return () => {
      alive = false;
    };
  }, []);

  const pickLaunch = (next: LaunchWindow): void => {
    picked.current = true;
    const previous = launch;
    setLaunch(next);
    setLaunchNote(null);
    void ipc.setLaunchWindow(next).catch(() => {
      // The radio goes back to what the file STILL says, re-read rather than
      // assumed: if the opening read had not landed before this press,
      // `previous` is the default rather than the machine's answer, and the
      // sentence below promises what the next launch will really open.
      const revert = async () => {
        try {
          setLaunch(await ipc.launchWindow());
        } catch {
          setLaunch(previous);
        }
        setLaunchNote("That choice could not be saved. The next launch opens what was saved before.");
      };
      void revert();
    });
  };

  const option = (opts: {
    /** The radio group this member belongs to; the two groups are separate. */
    name: string;
    id: string;
    on: boolean;
    title: string;
    body: string;
    onPick: () => void;
  }): ReactElement => (
    <label className="choice-row" htmlFor={opts.id}>
      <input
        type="radio"
        name={opts.name}
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
        name: "supervision-mode",
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
        name: "supervision-mode",
        id: "sup-app",
        on: !chosen.background,
        title: "With this app",
        body: "Runs while Subshell Server is open; quitting stops it. Running subshells keep running.",
        onPick: () => props.onChoice(applySupervisionChoice(chosen, { background: false })),
      })}
      {/* A second radio group, on purpose rather than by omission: two options
          with names on them is the only spelling that says what the other
          choice IS, which a switch cannot do. It sits under its own heading
          because it answers a different question from the modes above, and it
          saves on the press rather than at Apply. */}
      <p className="group-heading">Open on launch</p>
      {option({
        name: "launch-window",
        id: "launch-dashboard",
        on: launch === "dashboard",
        title: "The control plane",
        body: "The server's own page, at its address on this machine.",
        onPick: () => pickLaunch("dashboard"),
      })}
      {option({
        name: "launch-window",
        id: "launch-assistant",
        on: launch === "assistant",
        title: "The assistant",
        body: "This app's own page, where Service, Addresses and Reset live.",
        onPick: () => pickLaunch("assistant"),
      })}
      <p className="hint">
        Saved as you change it. It decides the next launch, and only when the server is already running; anything else
        opens the assistant whatever is chosen here.
      </p>
      {launchNote && <p className="hint bad-text">{launchNote}</p>}
      {out && <pre className={out.failed ? "output output-bad" : "output"}>{out.text}</pre>}
    </Frame>
  );
}
