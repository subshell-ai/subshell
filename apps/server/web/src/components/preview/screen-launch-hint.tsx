import type { JSX } from "react";
import type { PreviewScreen } from "@/hooks/use-subshell-preview";

/**
 * The line a `screen` pane's row carries for an `edit` viewer: the DISPLAY
 * value, stated. The pane's harness already has it in its environment, but
 * "what did the launch hand it" is the one thing nobody can read off the
 * terminal - and the enabled Screen viewer over the RFB lane is Task 13's,
 * so today's honest copy is the fact, not a button that lies.
 */

export interface ScreenLaunchHintProps {
  /** The live display, from the pane's info answer. */
  screen: PreviewScreen;
}

export function ScreenLaunchHint({ screen }: ScreenLaunchHintProps): JSX.Element {
  return (
    <span className="text-detail text-muted-foreground">
      DISPLAY={screen.display} · screencast bridge on loopback port {screen.rfbPort}
    </span>
  );
}
