/**
 * Install tmux — the hard gate in front of registering this machine
 * (spec 2026-09-18 § 5.2).
 *
 * Two things about it are deliberate, and both are the sibling app's
 * `renderTmux` (wizard.ts) rather than a new idea:
 *
 * - **There is no Continue, and no skip.** Every subshell runs in a tmux pane,
 *   so a node without one comes up online with an empty harness inventory and
 *   409s every launch — and `subshell enroll` refuses before its network call,
 *   which is what keeps a tmux-less box from spending a single-use setup key.
 *   The screen therefore has no way past it: it LEAVES BY ITSELF, when the
 *   poll next sees a tmux and the router stops routing here. A skip would only
 *   manufacture the failure nobody attributes to tmux.
 * - **The command is shown whether or not the button is offered.** The install
 *   runs the platform's package manager as this user, and on Linux that needs a
 *   password this app has no terminal to answer — so the one line a person can
 *   paste into a terminal is not a fallback for a failure, it is on screen
 *   before the press.
 *
 * The status line exists for the same reason the server's "Checking for tmux…"
 * does: this screen is the one a person walks away from to go and fix the
 * machine, and a window that says nothing about watching looks frozen.
 */
import { SquareTerminal } from "lucide-react";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { Button } from "@/components/ui/button";
import { TMUX_INSTALL_CMD } from "@/lib/copy";
import type { Probe } from "@/lib/ipc";

export function TmuxScreen(props: {
  shell: FrameShell;
  probe: Probe | undefined;
  /** Runs the platform's tmux install; the host owns the command and its output. */
  onInstall: () => void;
  busy: boolean;
}) {
  const { shell, probe, onInstall, busy } = props;
  // Named rather than inlined into the JSX: the three cases are one sentence
  // each and the screen's whole liveness is which one is showing.
  const status = busy
    ? "Installing tmux…"
    : probe && !probe.tmux
      ? "tmux was not found on the login PATH. This screen continues on its own as soon as it is there."
      : "Checking for tmux…";

  return (
    <Frame
      {...shell}
      icon={<SquareTerminal />}
      barRight={
        <Button className="min-w-[120px]" disabled={busy} onClick={onInstall}>
          Install tmux
        </Button>
      }
    >
      <p className="text-muted-foreground text-sm leading-relaxed">
        Every subshell runs in a tmux pane, so this machine needs tmux before it can run one.
      </p>
      <p role="status" className="mt-4 text-detail text-muted-foreground">
        {status}
      </p>
      <div className="mt-6">
        <p className="text-detail text-muted-foreground">Or run this in a terminal:</p>
        <p className="mt-2 break-all font-mono text-detail">{TMUX_INSTALL_CMD}</p>
        <p className="mt-2 text-detail text-muted-foreground">Your package manager may ask for your password.</p>
      </div>
    </Frame>
  );
}
