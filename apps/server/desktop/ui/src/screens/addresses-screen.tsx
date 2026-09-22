/**
 * **Server Addresses** (spec 2026-09-21; plan Task 6) — the port of
 * `renderSettings`.
 *
 * The four values that decide whether this server is reachable, edited from
 * the one page that needs no session to save them. It exists because a value
 * only the dashboard can change can make the dashboard unreachable: the case
 * it was BUILT for — an `https://` base URL marking the session cookie
 * `Secure` while this app opened its window on loopback http — was fixed by
 * opening the window on the configured address instead; what is left is an
 * address the operator configured and cannot reach, where the window lands on
 * a browser error. So the warning under the base URL field is the dashboard's
 * own sentence, verbatim (`HTTPS_RESTART_NOTE`).
 *
 * **Two acts, kept apart.** Save writes config.env through `desktop_setup` —
 * no new command, which is a requirement of § 14.2 rather than an outcome.
 * Restart is `desktop_service`, with the pane-safety refusal and its Force
 * override exactly as the update act has them. Nothing here changes
 * supervision — `settingsPayload` sends the machine's own answer so an edit to
 * a port cannot install a service.
 */
import { type AssistantStrings, Frame } from "@internal/assistant";
import { type ReactElement, useLayoutEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { type AddressForm, seedAddressForm } from "../lib/config-form";
import type { ActionResult, Probe } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import {
  HTTPS_RESTART_NOTE,
  httpsBaseUrl,
  SETTINGS_BLIND_WARNING,
  SETTINGS_RESTART_NOTE,
  settingsEdited,
  settingsForce,
  settingsKnown,
  settingsPayload,
  settingsSaveRefusal,
  settingsUnreadable,
} from "../lib/settings-screen";
import { leaveLabel } from "../lib/wizard-state";
import { AddressFields } from "./address-fields";

/** A result's own words, as the old `renderOutput` built them — or nothing. */
function outputOf(result: ActionResult | null): { text: string; failed: boolean } | null {
  const parts: string[] = [];
  if (result?.stdout?.trim()) parts.push(result.stdout.trim());
  if (result?.stderr?.trim()) parts.push(result.stderr.trim());
  if (parts.length === 0) return null;
  return { text: parts.join("\n\n"), failed: result?.ok === false };
}

export function AddressesScreen(props: {
  /** The rail node the host computed for this route, or undefined when the route is full-window. */
  rail?: ReactElement;
  strings: AssistantStrings;
  entranceKey?: number;
  probe: Probe;
  busy: boolean;
  running: boolean;
  /** The visit's form state, or null while it is not seeded yet. */
  settingsForm: AddressForm | null;
  onSeedForm: (form: AddressForm) => void;
  blind: boolean;
  onBlindChange: (blind: boolean) => void;
  /** The Force box, once touched; null is untouched, and untouched means unticked. */
  forceChecked: boolean | null;
  onForceToggle: (checked: boolean) => void;
  settingsResult: ActionResult | null;
  onSettingsEdit: (values: AddressForm["values"], explicit: AddressForm["explicit"]) => void;
  onRunSettings: (fn: () => Promise<ActionResult>) => void;
  onClose: () => void;
}): ReactElement {
  const { probe, busy, running } = props;
  const locked = busy || running;

  // Seeded once per VISIT, not once per load: this screen is opened to look at
  // what the machine currently has, and a value left over from a visit before
  // a CLI-side edit would be the stale field the prefill exists to prevent.
  // `applyScreen` and `host.close()` clear it on the way out.
  //
  // **And never from a probe that could not read the machine.** `p.status` is
  // null both for a failed `status --json` spawn and for a machine with no
  // server at all, and seeding on the first is how a configured port 4000 gets
  // a form full of 3080 and a Save that looks like a repair. `settingsKnown`
  // is the distinction; until it is true the screen renders its own "reading
  // this machine" line and no form. A LAYOUT effect: the old render seeded
  // before it drew, so the form's first paint already had the machine's
  // values in it.
  useLayoutEffect(() => {
    if (props.settingsForm === null && (settingsKnown(probe) || props.blind)) {
      props.onSeedForm(seedAddressForm(probe.status?.settings));
    }
  }, [props.settingsForm, props.blind, probe, props.onSeedForm]);

  const state = props.settingsForm;

  if (state === null) {
    // **A hold needs a way out.** While the read is merely pending this is a
    // moment — the poll is 1500 ms and the bar still carries Back and
    // Restart. But a server binary whose `status --json` keeps failing would
    // sit here forever, on the machine this screen exists for, so the probe's
    // own words appear as soon as it has any and the person can choose to
    // configure without a reading.
    const why = settingsUnreadable(probe);
    const unreadable = why !== null && probe.error !== null;
    return (
      <Frame
        rail={props.rail}
        strings={props.strings}
        entranceKey={props.entranceKey}
        barLeft={
          <Button type="button" variant="ghost" disabled={locked} onClick={props.onClose}>
            {leaveLabel(probe, probe.onboarded)}
          </Button>
        }
        barRight={
          <>
            {unreadable && (
              <Button type="button" variant="ghost" disabled={locked} onClick={() => props.onBlindChange(true)}>
                Configure anyway
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              disabled={locked}
              onClick={() => props.onRunSettings(() => ipc.service("restart", false))}
            >
              Restart
            </Button>
          </>
        }
      >
        <p className="hint">Reading this machine's configuration…</p>
        {unreadable && (
          <>
            <p className="hint warn-text">{why}</p>
            <p className="hint">{SETTINGS_BLIND_WARNING}</p>
          </>
        )}
      </Frame>
    );
  }

  // The same sentence, now above the fields it is about: they are a proposal
  // rather than a reading, and someone who joined here would otherwise read
  // defaults as the machine's own settings.
  const blindWarning = props.blind && !settingsKnown(probe);
  const force = settingsForce(probe, props.forceChecked ?? false);
  const refusal = settingsSaveRefusal(probe, props.blind);
  const out = outputOf(props.settingsResult);
  return (
    <Frame
      rail={props.rail}
      strings={props.strings}
      entranceKey={props.entranceKey}
      barLeft={
        <Button type="button" variant="ghost" disabled={locked} onClick={props.onClose}>
          {leaveLabel(probe, probe.onboarded)}
        </Button>
      }
      barRight={
        <>
          {/* The CLI's own refusal where the person still is — `init`'s refusals
              name the config key they are about, and this screen is where that
              is actionable. THIS screen's result, not the page's `lastResult`. */}
          {refusal !== null && <span className="reason">{refusal}</span>}
          {/* Restart is offered whatever the form holds: someone who reached this
              screen because their server is unreachable may have nothing to save
              and still need the restart that applies a change made elsewhere. */}
          <Button
            type="button"
            variant="ghost"
            disabled={locked}
            onClick={() => props.onRunSettings(() => ipc.service("restart", force?.checked === true))}
          >
            Restart
          </Button>
          <Button
            type="button"
            disabled={locked || refusal !== null || !settingsEdited(probe, state)}
            onClick={() => props.onRunSettings(() => ipc.setup(settingsPayload(probe, state)))}
          >
            Save
          </Button>
        </>
      }
    >
      {blindWarning && <p className="hint warn-text">{SETTINGS_BLIND_WARNING}</p>}
      <AddressFields
        values={state.values}
        explicit={state.explicit}
        settings={probe.status?.settings}
        onEdit={(edit) => {
          props.onSettingsEdit(edit.values, edit.explicit);
          // Both fields, because the port moves the base URL too while nobody
          // has chosen one (`addressForm`'s mirror). A controlled input
          // re-renders per keystroke, so the note toggles AS the field is
          // typed — the old page needed an in-place DOM toggle only because
          // its poll skipped renders under a typing hand.
        }}
        note={(field, values) =>
          field.name === "baseUrl" ? (
            <p className="hint" hidden={!httpsBaseUrl(values.baseUrl)}>
              {HTTPS_RESTART_NOTE}
            </p>
          ) : null
        }
      />
      <p className="hint">{SETTINGS_RESTART_NOTE}</p>

      {/* The Force box, above the bar that carries the Restart it governs — the
          same box, the same sentence and the same fail-closed rule as the
          update act's, because it is the same restart of the same server. */}
      {force !== null && (
        <>
          <p className="hint warn-text">{force.warning}</p>
          <div className="mt-2 flex items-center gap-2.5">
            <Switch
              id="settings-force"
              checked={force.checked}
              disabled={locked}
              onCheckedChange={(checked) => props.onForceToggle(checked)}
            />
            <Label htmlFor="settings-force">{force.label}</Label>
          </div>
        </>
      )}

      {out && <pre className={out.failed ? "pane-pre output-bad" : "pane-pre"}>{out.text}</pre>}
    </Frame>
  );
}
