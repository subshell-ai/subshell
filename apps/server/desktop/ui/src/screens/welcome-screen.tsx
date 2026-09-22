/**
 * The intro (spec 2026-09-21; plan Task 3) — the port of `renderWelcome`.
 *
 * Wordmark and one sentence — before the first probe there is nothing to say
 * but who is speaking, and the D1 removal (spec 2026-09-17, "a first run
 * announces itself by DOING") lasted one day: the operator asked for it back
 * on 2026-09-18, "reset / initial state should always show it again", which
 * the probe-derived list gives for free.
 *
 * Continue is the only control, and it carries weight: the setup chain's
 * auto-fire lives in the setup screen, which this screen does not render, so
 * NOTHING has touched the machine while the intro is up. The press does not
 * start a journey — it steps to the one act `screensFor` has behind the
 * greeting (form, auto-fire, or the tmux stop; the choice is the model's,
 * computed at press time so a tmux that appeared mid-read is honoured — which
 * is why the host makes that computation, not this screen).
 */
import { type AssistantStrings, Frame } from "@internal/assistant";
import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";

/** The wordmark, transcribed from the old page's `ART.icon`: the CSP allows no remote images. */
export function Wordmark(): ReactElement {
  return <img src="./wordmark-96.png" srcSet="./wordmark-96.png 1x, ./wordmark-192.png 2x" alt="" />;
}

export function WelcomeScreen(props: {
  strings: AssistantStrings;
  /** The Continue press. The host computes the step from the CURRENT probe. */
  onContinue: () => void;
  /** Whether controls are disabled (an act in flight, or the chain running). */
  disabled: boolean;
  /** The host's screen-change epoch, for the entrance animation. */
  entranceKey?: number;
}): ReactElement {
  return (
    <Frame
      strings={props.strings}
      entranceKey={props.entranceKey}
      art={<Wordmark />}
      barRight={
        <Button type="button" disabled={props.disabled} onClick={props.onContinue}>
          Continue
        </Button>
      }
    />
  );
}
