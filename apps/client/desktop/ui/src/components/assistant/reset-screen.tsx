/**
 * Reset This Mac — a PLACEHOLDER until Task 26.
 *
 * The real chain is the approved client reset
 * (`docs/superpowers/specs/2026-09-11-native-reset-both-desktop-apps-design.md`
 * § 7.2): `node_arm_reset` stashes a delete plan taken from the CLI's own
 * `status --json` `paths` block, the screen lists the five deletion rows and
 * the disclosures paragraph, and `node_reset` runs only behind a typed
 * hostname. None of that exists yet — the Rust commands are Task 26's, and
 * this half of the work is TypeScript only, so the screen offers Cancel and
 * says plainly that it is unbuilt rather than rendering a Reset button that
 * would reject at the IPC boundary.
 *
 * It is routed to on purpose even so: `screenFor` already answers `reset` for
 * the override, and a screen that exists as a dead end is easier to finish
 * than one whose route has to be added later.
 */
import { TriangleAlert } from "lucide-react";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { hereLower } from "@/components/assistant/subtitles";
import { Button } from "@/components/ui/button";

export function ResetScreen(props: { shell: FrameShell; busy: boolean; platform: string; onCancel: () => void }) {
  const { shell, busy, platform, onCancel } = props;
  return (
    <Frame
      {...shell}
      icon={<TriangleAlert />}
      barLeft={
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      }
    >
      <p className="text-muted-foreground text-sm leading-relaxed">
        Resetting is not available in this build yet. When it lands it will stop and remove the node service, delete
        this machine's node configuration and its data directory, and leave the control plane's own record of the node
        for an admin to remove.
      </p>
      <p className="mt-3 text-muted-foreground text-sm leading-relaxed">
        Nothing on {hereLower(platform)} has been changed by opening this screen.
      </p>
    </Frame>
  );
}
