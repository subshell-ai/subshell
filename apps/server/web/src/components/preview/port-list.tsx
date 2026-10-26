import { Button, cn, Input } from "@internal/node-admin";
import { AppWindow, ArrowRight, Eye, Globe, type LucideIcon, Search } from "lucide-react";
import { type JSX, useState } from "react";
import type { PreviewInfo } from "@/hooks/use-subshell-preview";
import type { SubshellAccess } from "@/types/subshell";

/**
 * The pane's previewable choices (spec §7): one per listening port, one per
 * virtual display. Actions are the three named verbs - Open, Watch, Screen -
 * and each gated one explains itself (the design system's disabled-control
 * rule): a disabled control says WHY, never silently vanishes. Only a
 * `screenLost` row is absent on purpose: a dead display has no control left
 * to explain.
 *
 * Every caller shows this list in the same shape - the chooser dialog and a
 * preview tab before its viewer opens - so one compact render serves them all.
 * The Screen verb opens the raw lane against the display's RFB port and the
 * caller decides where that goes (the preview tab hosts the noVNC viewer).
 * Kind detection is what the info answer carries, nothing clever: a port the
 * pane speaks CDP on is the browser-debug row (that is where Watch lives), and
 * the screen row only exists when the display does.
 */

/** Why a `view` grantee cannot take the raw-lane act (spec §6: open is `edit`). */
export const OPEN_VIEW_REASON = "Opening a forwarded port needs edit access to this subshell.";
/** Why a `view` grantee cannot open the noVNC surface (spec §7: Screen is `edit`-gated). */
export const SCREEN_VIEW_REASON = "Virtual display needs edit access to this subshell.";

/** The remedy line per plane-side reason word, for rows shown while the node cannot serve. */
export function nodeReasonLine(reason: string | undefined): string {
  switch (reason) {
    case "virtual-display-disabled":
      return "Virtual displays are disabled in this node’s settings.";
    case "web-previews-disabled":
      return "Web previews are disabled in this node’s settings.";
    case "preview-ports-unsupported":
      return "This machine doesn’t support automatic port discovery or browser watching. Add a service by port instead. Virtual screens need Linux.";
    case "preview-disabled":
      return "Web previews & screens is switched off on this node. Its owner can turn it on in node settings.";
    case "node-held":
      return "This node needs attention before it can serve web previews and screens. Check its status in node settings.";
    case "node-too-old":
      return "Update Subshell on this node to use web previews and screens.";
    case "node-offline":
      return "This node is offline. Reconnect it to open web previews and screens.";
    case "node-timeout":
      return "The node didn't answer the view discovery request in time. Try again in a moment.";
    default:
      return `The node can't serve web previews and screens right now${reason ? ` (${reason})` : ""}.`;
  }
}

export interface PortListProps {
  busy?: boolean;
  info: PreviewInfo;
  access: SubshellAccess;
  /** The Watch half of this tab's browser row; the verb on the row reflects it. */
  watching: boolean;
  onOpen: (port: number) => void;
  onWatch: () => void;
  /** The Screen verb: open the raw lane on the display's RFB port. */
  onScreen: () => void;
}

export function PortList({
  info,
  access,
  watching,
  onOpen,
  onWatch,
  onScreen,
  busy = false,
}: PortListProps): JSX.Element | null {
  // The same port can appear once per family (a dev server on tcp AND tcp6);
  // it is one choice for the viewer, so it is one row.
  const rows = info.ports.filter((row, index, all) => all.findIndex((other) => other.port === row.port) === index);
  const openReason =
    access === "view"
      ? OPEN_VIEW_REASON
      : busy
        ? "Opening the selected view…"
        : !info.nodeEnabled || info.webPreviewsEnabled === false
          ? nodeReasonLine(info.webPreviewsEnabled === false ? "web-previews-disabled" : info.reason)
          : undefined;
  // Access first, then the node switch: a disabled control on a dead node
  // still reads true when the switch's remedy names it.
  const screenReason =
    access === "view"
      ? SCREEN_VIEW_REASON
      : busy
        ? "Opening the selected view…"
        : !info.nodeEnabled || info.virtualDisplayEnabled === false
          ? nodeReasonLine(info.virtualDisplayEnabled === false ? "virtual-display-disabled" : info.reason)
          : undefined;
  // The same node-switch reason the Open row already carries: a disabled
  // Watch must explain itself like its siblings, not sit mute.
  const watchReason = busy
    ? "Opening the selected view…"
    : info.nodeEnabled && info.webPreviewsEnabled !== false
      ? undefined
      : nodeReasonLine(info.webPreviewsEnabled === false ? "web-previews-disabled" : info.reason);

  if (rows.length === 0 && info.cdpPort === null && info.screen === null && info.screenLost === undefined) return null;

  return (
    <CompactPreviewChoices
      rows={rows}
      info={info}
      openReason={openReason}
      screenReason={screenReason}
      watchReason={watching ? "This browser is already being watched." : watchReason}
      onOpen={onOpen}
      onScreen={onScreen}
      onWatch={onWatch}
    />
  );
}

/** One focus target per choice, with its unavailable reason visible on touch too. */
function PreviewOption({
  icon: Icon,
  label,
  port,
  action,
  reason,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  port?: number;
  action: string;
  reason?: string;
  onClick: () => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start gap-2"
        aria-label={action}
        disabled={Boolean(reason)}
        disabledReason={reason}
        onClick={onClick}
      >
        <Icon data-icon="inline-start" aria-hidden />
        <span>{label}</span>
        {port !== undefined && <span className="text-muted-foreground tabular-nums">{port}</span>}
        <ArrowRight className="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden />
      </Button>
      {reason && <p className="text-detail text-muted-foreground">{reason}</p>}
    </div>
  );
}

function CompactPreviewChoices({
  rows,
  info,
  openReason,
  screenReason,
  watchReason,
  onOpen,
  onScreen,
  onWatch,
}: {
  rows: PreviewInfo["ports"];
  info: PreviewInfo;
  openReason?: string;
  screenReason?: string;
  watchReason?: string;
  onOpen: (port: number) => void;
  onScreen: () => void;
  onWatch: () => void;
}) {
  const [query, setQuery] = useState("");
  const large = rows.length + Number(Boolean(info.screen)) + Number(info.cdpPort != null) > 6 || query.length > 0;
  const term = query.trim().toLowerCase();
  const webPreviews = [...rows]
    .sort((a, b) => a.port - b.port)
    .filter((row) => `web preview port ${row.port}`.includes(term));
  const screen = info.screen && "virtual display screen".includes(term);
  const browser = info.cdpPort != null && `browser watch ${info.cdpPort}`.includes(term);
  const special = (
    <>
      {screen && (
        <PreviewOption
          icon={AppWindow}
          label="Virtual display"
          action="View screen"
          reason={screenReason}
          onClick={onScreen}
        />
      )}
      {browser && (
        <PreviewOption icon={Eye} label="Browser" action="Watch browser" reason={watchReason} onClick={onWatch} />
      )}
    </>
  );
  return (
    <div className={cn("flex min-h-0 flex-col", large ? "gap-2" : "gap-0.5 rounded-md border p-1")}>
      {large && (
        <div className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            aria-label="Find a web preview or screen"
            placeholder="Find a port or view…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-9"
          />
        </div>
      )}
      {large && (screen || browser) && <div className="shrink-0 rounded-md border p-1">{special}</div>}
      {large && (
        <p role="status" className="text-detail text-muted-foreground">
          {term ? `${webPreviews.length} of ${rows.length} web previews` : `${rows.length} web previews`}
        </p>
      )}
      {webPreviews.length > 0 && (
        <div
          className={cn(
            "flex flex-col",
            large ? "max-h-[40dvh] gap-0.5 overflow-y-auto overscroll-contain rounded-md border p-1" : "gap-0.5",
          )}
        >
          {webPreviews.map((row) => (
            <PreviewOption
              key={row.port}
              icon={Globe}
              label="Web preview"
              port={row.port}
              action={`Open web preview on port ${row.port}`}
              reason={openReason}
              onClick={() => onOpen(row.port)}
            />
          ))}
        </div>
      )}
      {!large && special}
      {term && !webPreviews.length && !screen && !browser && (
        <p role="status" className="py-3 text-detail text-muted-foreground">
          No matching web previews or screens.
        </p>
      )}
      {!info.screen && info.screenLost !== undefined && (
        <p className="text-detail text-muted-foreground">Display stopped: {info.screenLost} exited</p>
      )}
    </div>
  );
}
