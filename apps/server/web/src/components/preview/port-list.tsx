import { Badge, Button } from "@internal/node-admin";
import { Monitor } from "lucide-react";
import type { JSX } from "react";
import type { PreviewInfo } from "@/hooks/use-subshell-preview";
import type { SubshellAccess } from "@/types/subshell";

/**
 * The pane's previewable rows (spec §7): one per listening port, one per
 * virtual display. Actions are the three named verbs - Open, Watch, Screen -
 * and each gated one explains itself (the design system's disabled-control
 * rule): a disabled control says WHY, never silently vanishes. Only a
 * `screenLost` row is absent on purpose: a dead display has no control left
 * to explain.
 *
 * The Screen button opens the raw lane against the display's RFB port and
 * the noVNC viewer mounts in the panel (spec §6, decision 6); the caller
 * decides where that goes. Kind detection is what the info answer carries,
 * nothing clever: a port the pane speaks CDP on is the browser-debug row
 * (that is where Watch lives), and the screen row only exists when the
 * display does.
 */

/** Why a `view` grantee cannot take the raw-lane act (spec §6: open is `edit`). */
export const OPEN_VIEW_REASON = "Opening a forwarded port needs edit access to this subshell.";
/** Why a `view` grantee cannot open the noVNC surface (spec §7: Screen is `edit`-gated). */
export const SCREEN_VIEW_REASON = "Screen preview needs edit access to this subshell.";

/**
 * Why the phone layout disables Screen even at `edit` (spec §7's panel never
 * renders there): pressing it would open a real lane no viewer would ever
 * pump, and the press would read as a failure. Watch is the verb a phone
 * serves, so the reason says the frames are still there.
 */
export const SCREEN_PHONE_REASON =
  "Screen preview needs the panel, and phones do not have one. Watch still streams frames here.";

/** The remedy line per plane-side reason word, for rows shown while the node cannot serve. */
export function nodeReasonLine(reason: string | undefined): string {
  switch (reason) {
    case "preview-disabled":
      return "Preview is switched off on this node. Its owner can turn it on in node settings.";
    case "node-held":
      return "This node is held for one command right now. Preview waits until the hold ends.";
    case "node-too-old":
      return "Update this node's agent to use preview.";
    case "node-offline":
      return "This node is offline. Preview works when it comes back.";
    case "node-timeout":
      return "The node didn't answer the preview check in time. Try again in a moment.";
    default:
      return `The node can't serve preview right now${reason ? ` (${reason})` : ""}.`;
  }
}

export interface PortListProps {
  info: PreviewInfo;
  access: SubshellAccess;
  /** The Watch half of this tab's browser row; the verb on the row reflects it. */
  watching: boolean;
  onOpen: (port: number) => void;
  onWatch: () => void;
  onStopWatch: () => void;
  /** The Screen verb: open the raw lane on the display's RFB port. */
  onScreen: () => void;
  /** The phone layout: the panel does not render there, so Screen loses its host. */
  phone?: boolean;
}

export function PortList({
  info,
  access,
  watching,
  onOpen,
  onWatch,
  onStopWatch,
  onScreen,
  phone,
}: PortListProps): JSX.Element | null {
  const rows = info.ports;
  const openReason = access === "view" ? OPEN_VIEW_REASON : !info.nodeEnabled ? nodeReasonLine(info.reason) : undefined;
  // Access first, the node switch second, the layout last: on a phone with a
  // dead node the switch's remedy still reads true, and it is only once the
  // node serves again that "this layout has no panel" becomes the live reason.
  const screenReason =
    access === "view"
      ? SCREEN_VIEW_REASON
      : !info.nodeEnabled
        ? nodeReasonLine(info.reason)
        : phone
          ? SCREEN_PHONE_REASON
          : undefined;
  // The same node-switch reason the Open row already carries: a disabled
  // Watch must explain itself like its siblings, not sit mute.
  const watchReason = info.nodeEnabled ? undefined : nodeReasonLine(info.reason);

  if (rows.length === 0 && info.screen === null && info.screenLost === undefined) return null;

  return (
    <div className="flex flex-col gap-1">
      {rows.map((p) => {
        const browser = p.port === info.cdpPort;
        return (
          <div key={`${p.proto}:${p.port}`} className="flex items-center justify-between gap-3 py-1">
            <div className="flex min-w-0 flex-col">
              <span className="font-strong text-label">
                {p.port}{" "}
                <Badge variant="secondary" className="ml-1 text-detail">
                  {browser ? "browser-debug" : "server"}
                </Badge>
              </span>
              <span className="text-detail text-muted-foreground">
                {p.proto} loopback · pid {p.pid}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={openReason !== undefined}
                disabledReason={openReason}
                onClick={() => onOpen(p.port)}
              >
                Open
              </Button>
              {browser &&
                (watching ? (
                  <Button variant="outline" size="sm" onClick={onStopWatch}>
                    Stop
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={watchReason !== undefined}
                    disabledReason={watchReason}
                    onClick={onWatch}
                  >
                    Watch
                  </Button>
                ))}
            </div>
          </div>
        );
      })}

      {info.screen !== null && (
        <div className="flex items-center justify-between gap-3 py-1">
          <div className="flex min-w-0 flex-col">
            <span className="font-strong text-label">
              <Monitor className="mr-1 inline size-3.5" aria-hidden />
              Screen{" "}
              <Badge variant="secondary" className="text-detail">
                screen
              </Badge>
            </span>
            <span className="text-detail text-muted-foreground">Virtual display {info.screen.display}</span>
          </div>
          {/* One control for every tier (round-14 MINOR: the render contract
              is ONE, so the disabled-for-view affordance Task 12 pins and the
              enabled-for-edit action share this button). `edit` clears the
              reason - the raw lane is an edit act (spec §6) - except on the
              phone layout, where the panel Screen needs does not render and
              the layout becomes the reason instead. */}
          <Button
            variant="outline"
            size="sm"
            disabled={screenReason !== undefined}
            disabledReason={screenReason}
            onClick={onScreen}
          >
            Screen
          </Button>
        </div>
      )}

      {info.screen === null && info.screenLost !== undefined && (
        <div className="flex flex-col py-1">
          <span className="font-strong text-label">
            <Monitor className="mr-1 inline size-3.5" aria-hidden />
            Screen
          </span>
          {/* The loss line (spec §9): named, and honest that the pane itself lives on. */}
          <span className="text-detail text-muted-foreground">Display stopped: {info.screenLost} exited</span>
        </div>
      )}
    </div>
  );
}
