/**
 * The ready handoff (spec 2026-09-21; plan Task 3) — the port of
 * `renderHandoff`, all three of its arms.
 *
 * The last screen either family sees: the server answers, so the dashboard is
 * what comes next. It dismisses itself ONLY when this window ran nothing —
 * the handoff of a chain that ran here holds the completed checklist and
 * waits for the person's Continue, because a pane that navigates away at the
 * moment it turns into an answer is the jarring thing the operator reported
 * (2026-09-17; `handoffView` carries the whole history).
 *
 * The reference map sends the ready (non-waiting) half to `StatusScreen`; it
 * renders HERE instead, because the route kind for the ready state is
 * `handoff`, not `status` — one component per route kind. The arm is four
 * lines: the title says where the window is going and the host's
 * `openWhenReady` effect does the opening.
 *
 * The auto-open itself is the HOST's effect (it owns `opened`/`openFailed`
 * and the `handoffView` gate); this screen renders whichever arm the same
 * facts pick.
 */
import { type AssistantStrings, Frame } from "@internal/assistant";
import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import type { FormValues } from "../lib/config-form";
import type { Probe } from "../lib/ipc";
import type { SupervisionChoice } from "../lib/wizard-state";
import { Checklist } from "./setup-screen";

export function HandoffScreen(props: {
  /** The rail node the host computed for this route, or undefined when the route is full-window. */
  rail?: ReactElement;
  strings: AssistantStrings;
  /** The host's screen-change epoch, for the entrance animation. */
  entranceKey?: number;
  probe: Probe;
  busy: boolean;
  form: FormValues;
  supervision: SupervisionChoice;
  /** The dashboard refused to open, so stop retrying and let the human press something. */
  openFailed: boolean;
  onRetryOpen: () => void;
  /** Whether the completed checklist is on screen, waiting for the person's Continue. */
  waiting: boolean;
  onContinue: () => void;
}): ReactElement {
  if (props.openFailed) {
    return (
      <Frame
        rail={props.rail}
        strings={props.strings}
        entranceKey={props.entranceKey}
        barRight={
          <Button type="button" disabled={props.busy} onClick={props.onRetryOpen}>
            Open Dashboard
          </Button>
        }
      />
    );
  }
  if (!props.waiting) {
    // The auto path: the title says where the window is going, and the host's
    // effect opens the dashboard. Nothing else to draw.
    return <Frame rail={props.rail} strings={props.strings} entranceKey={props.entranceKey} />;
  }
  return (
    <Frame
      rail={props.rail}
      strings={props.strings}
      entranceKey={props.entranceKey}
      barRight={
        <Button type="button" disabled={props.busy} onClick={props.onContinue}>
          Continue
        </Button>
      }
    >
      {/* The checklist stays on screen, every row ticked. It is the answer to
          "what did that just do", and on a machine that already had everything
          it is the only chance to read it. The press is deliberately the plain
          one — the auto path's opening is the same call, so the dashboard
          opening is identical whichever door it opens through. */}
      <Checklist
        probe={props.probe}
        form={props.form}
        supervision={props.supervision}
        undoneState="active"
        failure={null}
      />
    </Frame>
  );
}
