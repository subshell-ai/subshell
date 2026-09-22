/**
 * **Update Subshell Server** (spec 2026-09-21; plan Task 5) — the port of
 * `renderUpdate`, both phases, with `runUpdateCheck`, `startAppUpdate` and
 * `finishUpdate` in the action layer (`runners.ts`).
 *
 * The app AND the server it ships, in one act across the relaunch between
 * them. Every judgment is in `lib/update-act.ts`, which is pure and tested;
 * what is left here is the table, the ticks, and the two presses.
 *
 * Two effects carry the old render()'s two side doors:
 *
 * - **The release check** is kicked from the SCREEN's presence, exactly as the
 *   old render's update arm did (`every door — the tray item, the SPA's deep
 *   link, and the boot resume — arrives through `screen``). The gate is the
 *   pending-install marker: phase 2 is about installing the server the app it
 *   just installed ships, and asking a third party whether a newer app exists
 *   is both irrelevant and the one thing on this screen that can hang for 20
 *   seconds. `runUpdateCheck(false)` is a no-op once an answer exists, so the
 *   re-renders cost nothing.
 * - **The automatic resume** is the only thing on this page that acts without
 *   a press, and it is the SECOND half of a press already made. Fired once
 *   per VISIT to this screen (`applyScreen` clears the latch), like the first
 *   run's chain. It carries the consent the marker recorded rather than
 *   anything on screen — nobody is here to answer.
 */
import { type AssistantStrings, Frame } from "@internal/assistant";
import { type ReactElement, useEffect } from "react";
import type { ActionResult, AppUpdateCheck, Probe } from "../lib/ipc";
import { type ActState, leaveHeld, type UpdateActPress, type UpdateActSelection, updateAct } from "../lib/update-act";

/**
 * A result's own words, as the old `renderOutput` built them: both streams,
 * trimmed and joined, or `null` when the press said nothing at all — a bare
 * bordered void is the one shape to avoid (`.pane-pre:empty` collapses it).
 */
function outputOf(result: ActionResult | null): { text: string; failed: boolean } | null {
  const parts: string[] = [];
  if (result?.stdout?.trim()) parts.push(result.stdout.trim());
  if (result?.stderr?.trim()) parts.push(result.stderr.trim());
  if (parts.length === 0) return null;
  return { text: parts.join("\n\n"), failed: result?.ok === false };
}

export function UpdateScreen(props: {
  /** Title and problem; the screen adds the subtitle from the view. */
  strings: AssistantStrings;
  entranceKey?: number;
  probe: Probe;
  appUpdate: AppUpdateCheck | null;
  state: ActState;
  finished: ActionResult | null;
  selection: UpdateActSelection;
  busy: boolean;
  /** The download/CLI half's own progress line, and the resume latch. */
  updateProgress: string;
  resumeFired: boolean;
  onResume: (forced: boolean) => void;
  onCheck: (force: boolean) => void;
  onRowToggle: (rowId: "app" | "cli", checked: boolean) => void;
  onForceToggle: (checked: boolean) => void;
  onPress: (press: UpdateActPress) => void;
  onClose: () => void;
}): ReactElement {
  const { probe, busy } = props;
  const view = updateAct({
    probe,
    appUpdate: props.appUpdate,
    state: props.state,
    finished: props.finished,
    selection: props.selection,
    busy,
  });
  const locked = busy || props.state !== "idle";

  // The release check, as the old render's update arm kicked it: whenever
  // this screen is up WITHOUT a pending marker, and a no-op once an answer
  // exists. Keyed on the marker's absence rather than on the probe, so the
  // poll's fresh identities do not re-fire it and the phase-2-to-done
  // transition (which CLEARS the marker) re-arms it.
  const pendingAbsent = probe.pendingInstall === null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: onCheck is guarded by runUpdateCheck
  useEffect(() => {
    // Keyed on the marker's absence ALONE — the array says so and means it.
    // `onCheck` is an inline arrow with a fresh identity every render, and
    // including it would run the body on every render, correct only because
    // `runUpdateCheck` guards. The guard is real, but the keying should not
    // lean on it.
    if (pendingAbsent) props.onCheck(false);
  }, [pendingAbsent]);

  // The automatic half of phase 2 — the second half of a press already made,
  // carrying the consent the marker recorded. Once per visit; the host clears
  // the latch when the screen is left.
  const autoResume = view.phase === "finishing" && view.press === null && !props.resumeFired;
  useEffect(() => {
    if (!autoResume) return;
    props.onResume(probe.pendingInstall?.forced ?? false);
  }, [autoResume, props.onResume, probe.pendingInstall?.forced]);

  return (
    <Frame
      strings={{ ...props.strings, subtitle: view.subtitle }}
      entranceKey={props.entranceKey}
      barRight={
        <>
          {/* ONE dismissal, and it is the leave (operator's call, 2026-09-18):
              on a ready machine it lands on the handoff, which opens the
              dashboard and closes this window — exactly what the old **Later**
              did; from the recovery screen's link there is somewhere to go
              back TO. Hidden's sibling: disabled rather than hidden while an
              install is actually running — a control that vanishes mid-act
              reads as a page that lost a button. `leaveHeld` owns the flags. */}
          {props.state === "idle" && !busy && view.phase !== "finishing" && (
            <button type="button" className="ghost" onClick={() => props.onCheck(true)}>
              Check Again
            </button>
          )}
          {/* **Close is this screen's PRIMARY, in the Save seat** (operator's
              call, 2026-09-18): the act is the big press in the CONTENT, so
              the bar's only job is the way out. Disabled while an install is
              actually running — on a ready machine the leave reaches
              `openWhenReady` → `open_main`, which DESTROYS this window, so
              the progress, the failure line and the phase-2 screen all go
              with it. */}
          <button
            type="button"
            className="primary"
            disabled={leaveHeld({ busy, state: props.state })}
            onClick={props.onClose}
          >
            Close
          </button>
        </>
      }
    >
      {/* The selection table (spec § 13.1). One line per component: what it
          runs, what it would become, and either a checkbox or the reason there
          is none. A `<label>` only where there is a control to label. */}
      {view.rows.map((row) => {
        const id = `update-row-${row.id}`;
        // A null target on a row that CAN act is the one number this build
        // cannot know: only the new bundle knows which server it carries
        // (§ 4.3). On a row that cannot act there is nothing it becomes.
        const versions =
          row.to !== null
            ? `${row.from} → ${row.to}`
            : row.selected !== null
              ? `${row.from} → the server it ships`
              : row.from;
        const copy = (key: string) => (
          <div key={key}>
            <div className="label">{row.label}</div>
            <div className="hint">{versions}</div>
          </div>
        );
        return row.selected === null ? (
          <div key={row.id} className="update-row">
            {copy("copy")}
            {/* The reason renders in the cell the checkbox would have occupied,
                and there is deliberately no disabled checkbox beside it: "not
                now" without a why is exactly what § 13 removed. */}
            {row.reason !== null && <span className="update-reason">{row.reason}</span>}
          </div>
        ) : (
          <label key={row.id} className="update-row" htmlFor={id}>
            {copy("copy")}
            <input
              type="checkbox"
              id={id}
              checked={row.selected}
              disabled={locked}
              onChange={(e) => props.onRowToggle(row.id, e.currentTarget.checked)}
            />
          </label>
        );
      })}

      {props.updateProgress !== "" && <p className="hint">{props.updateProgress}</p>}
      {/* The last run's own words, wherever it stopped. Phase 2 has no other way
          to report itself — nobody pressed anything, so a silent failure would
          be a screen that says "installing…" forever. */}
      {(view.phase === "halted" || (props.finished !== null && !props.finished.ok)) &&
        (() => {
          const out = outputOf(props.finished);
          return out && <pre className={out.failed ? "pane-pre output-bad" : "pane-pre"}>{out.text}</pre>;
        })()}

      {/* The long form of what this act will NOT do, one sentence each (§ 6). */}
      {view.notes.map((note) => (
        <p key={note} className="hint">
          {note}
        </p>
      ))}

      {/* The Force box, under the table it governs (§ 13.2). The amber sentence
          states what the restart costs; the box beside it is the only refusal
          on this screen a person may overrule. */}
      {view.force !== null && (
        <>
          <p className="hint warn-text">{view.force.warning}</p>
          <label className="switch update-force" htmlFor="update-force">
            <input
              type="checkbox"
              id="update-force"
              checked={view.force.checked}
              disabled={locked}
              onChange={(e) => props.onForceToggle(e.currentTarget.checked)}
            />
            <span className="label">{view.force.label}</span>
          </label>
        </>
      )}

      {view.press !== null && (
        <>
          {/* Linux installs through dpkg, which raises a system password sheet. A
              sheet nobody was told about reads as malware, which is the whole
              reason this sentence is here and is platform-branched — a genuine
              difference in what the user has to DO, not in voice. */}
          {view.press.kind === "app" && probe.platform === "linux" && (
            <p className="hint">Linux installs the package with dpkg, so your system will ask for your password.</p>
          )}
          <button
            type="button"
            className="primary big"
            disabled={!view.press.enabled}
            onClick={() => props.onPress(view.press as UpdateActPress)}
          >
            {view.press.label}
          </button>
        </>
      )}
    </Frame>
  );
}
