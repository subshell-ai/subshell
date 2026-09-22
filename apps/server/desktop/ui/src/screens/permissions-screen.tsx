/**
 * **What macOS Will Ask** (spec 2026-09-14 § 3; plan Task 7) — the port of
 * `renderPermissions`, `allowNotifications` and `allowPhotos`.
 *
 * Reached TWO ways, both of them requests: a dashboard detection notice, and —
 * on a Mac's first run — the ready screen's Continue handing off here before
 * the dashboard, once, because macOS asks each of these exactly once and a
 * first run that goes straight to a sign-in page has spent the one moment
 * when explaining them is cheap.
 *
 * **Nothing here blocks.** Every row answers in its own state and no Continue
 * gates anything: declining is a legitimate answer, and this screen is also
 * the way back from one, so gating the flow on an allow would make the
 * recovery path unreachable from the only place that offers it.
 *
 * **The in-flight flags are screen-local** (the two recorded module vars):
 * one flag per permission, never one shared flag — the two sheets are
 * different questions, and a single flag would spin the Photos row while the
 * person read the notifications sheet. Page state in the old module because
 * no probe can see it: the sheet is modal to the app and the answer only
 * reaches the probe on a later tick. A React component holds it for the same
 * visit, and the component unmounts when the screen is left — which resets
 * them, as the flags' per-screen scope always implied.
 */
import { type AssistantStrings, Frame } from "@internal/assistant";
import type { ReactElement } from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { ActionResult, Probe } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import type { PermissionRequest } from "../lib/permissions-model";
import { permissionRows } from "../lib/permissions-model";
import { leaveLabel } from "../lib/wizard-state";

export function PermissionsScreen(props: {
  strings: AssistantStrings;
  entranceKey?: number;
  probe: Probe;
  busy: boolean;
  running: boolean;
  /** The ready screen's Continue sent them here, so its own press is a Continue
   * that opens the dashboard rather than a Back that drops them where the
   * probe implies. */
  afterHandoff: boolean;
  /** One press: nothing else may run beside it, rejections are surfaced, and
   * the result is discarded — the row renders from the probe, which the poll
   * refreshes, so there is one source for what this machine allows. */
  act: (fn: () => Promise<ActionResult | null>, settle?: boolean) => Promise<void>;
  fail: (err: unknown) => void;
  onContinue: () => void;
  onClose: () => void;
}): ReactElement {
  const { probe, busy, running } = props;
  const [requestingNotifications, setRequestingNotifications] = useState(false);
  const [requestingPhotos, setRequestingPhotos] = useState(false);

  /**
   * Ask macOS, once.
   *
   * The flag is set BEFORE `act` so the very first render of the busy state
   * already shows the row spinning; `act` renders on entry, and setting it
   * inside the callback would leave one frame of a disabled button over a
   * pending row. The early return mirrors `act`'s own, or a press that `act`
   * ignored would leave the row spinning for the rest of the session.
   */
  const allowNotifications = (): void => {
    if (busy || running) return;
    setRequestingNotifications(true);
    void props.act(async () => {
      try {
        await ipc.requestNotifications();
      } finally {
        setRequestingNotifications(false);
      }
      return null;
    });
  };

  /**
   * Ask macOS for Photos, once — `allowNotifications` in every way that
   * matters, including the discarded result: this row renders from
   * `probe.photosPermission`, which the poll refreshes.
   *
   * What it raises is the sheet the image picker would have raised for
   * itself, so pressing this is not asking macOS a favour — it is moving the
   * same question to a screen that has already explained it (spec 2026-09-14
   * § 9, as amended by the operator on 2026-09-17).
   */
  const allowPhotos = (): void => {
    if (busy || running) return;
    setRequestingPhotos(true);
    void props.act(async () => {
      try {
        await ipc.requestPhotos();
      } finally {
        setRequestingPhotos(false);
      }
      return null;
    });
  };

  /**
   * Which handler each row's `allow` button reaches.
   *
   * A `Record` over the model's closed union rather than a chain of `if`s on
   * `row.id`: adding a third request to `PermissionRequest` without naming it
   * here is a compile error, where a dispatch that defaults would route it to
   * notifications and render a button that lies.
   */
  const REQUESTS: Record<PermissionRequest, () => void> = {
    notifications: allowNotifications,
    photos: allowPhotos,
  };

  return (
    <Frame
      strings={props.strings}
      entranceKey={props.entranceKey}
      barLeft={
        !props.afterHandoff && (
          <Button type="button" variant="ghost" disabled={busy || running} onClick={props.onClose}>
            {leaveLabel(probe, probe.onboarded)}
          </Button>
        )
      }
      barRight={
        props.afterHandoff && (
          /* Two doors, and the button says which one it came through. From the
              ready handoff this window's whole remaining job is to open the
              dashboard, so the press is a Continue that does it — a "Back"
              there would be the button lying about where it leads. Every OTHER
              door falls through to the shared ghost on the left, whose word
              `leaveLabel` picks by the same argument. */
          <Button type="button" disabled={busy || running} onClick={props.onContinue}>
            Continue
          </Button>
        )
      }
    >
      {/* The setup checklist's own glyphs, deliberately: "allowed" should look
          the same wherever this app says it, and a second visual language for
          done and failed is how two screens come to disagree about a tick. */}
      <ul className="checklist">
        {permissionRows(probe, { notifications: requestingNotifications, photos: requestingPhotos }).map((row) => (
          <li key={row.id} data-state={row.state}>
            <span className="glyph">{row.state === "done" ? "✓" : row.state === "failed" ? "✕" : ""}</span>
            <div className="permission-copy">
              <div className="label">{row.label}</div>
              <div className="detail">{row.detail}</div>
            </div>
            <div className="permission-side">
              {/* The right-hand text comes FIRST, then the buttons: the old page
                  appended the suffix before either button (wizard.ts:1856, before
                  the 1864/1870 appends), and styles.css documents that order
                  explicitly. */}
              {row.suffix !== "" && <span className="detail">{row.suffix}</span>}
              {/* Both the WORDS and the handler come from the row, so a request
                  added to the model without its handler here is a type error
                  rather than a silent mis-wiring. The old `button()` helper OR'd
                  `busy || running` into EVERY disabled state, these two
                  included: a press during an act is a no-op, and the buttons
                  must not look live. */}
              {/* The old code assigned `allow` to a local before the guard, so
                  the closure the button hands its press to had a narrowed
                  local rather than a property TS cannot narrow across a
                  callback — the non-null assertion the first port reached for
                  is that same gap, papered over. */}
              {(() => {
                const allow = row.allow;
                if (row.action !== "allow" || allow === null) return null;
                return (
                  <Button type="button" disabled={busy || running} onClick={() => REQUESTS[allow.request]()}>
                    {allow.label}
                  </Button>
                );
              })()}
              {row.action === "open-settings" && row.pane !== null && (
                /* No `ghost`: on the tmux screen that treatment read as a link
                    and did not say it could be pressed, and this is the one
                    control a person arrives here specifically to find. */
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || running}
                  onClick={() =>
                    void ipc
                      .openSystemSettings(row.pane as Parameters<typeof ipc.openSystemSettings>[0])
                      .catch(props.fail)
                  }
                >
                  Open System Settings
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Frame>
  );
}
