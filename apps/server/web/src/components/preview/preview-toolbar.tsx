import { Button, cn } from "@internal/node-admin";
import { ChevronDown, ExternalLink, Maximize2, Minimize2, MoreHorizontal, RefreshCw, Unplug } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type WorkspacePreviewTarget, workspacePreviewLabel } from "@/lib/workspace-preview";

export type PreviewConnection = "connecting" | "connected" | "disconnected";
export interface PreviewToolbarProps {
  selected: string | null;
  onOpenAnother: () => void;
  target?: WorkspacePreviewTarget | null;
  onRefresh: () => void;
  onDisconnect: () => void;
  onFullscreen: () => void;
  fullscreen: boolean;
  fullscreenSupported: boolean;
  appUrl?: string;
  appInBrowserTab?: boolean;
  busy: boolean;
  connection: PreviewConnection;
}

/** One toolbar owns the picker shortcut and viewer actions, leaving the panel to the picture. */
export function PreviewToolbar({
  selected,
  onOpenAnother,
  target,
  onRefresh,
  onDisconnect,
  onFullscreen,
  fullscreen,
  fullscreenSupported,
  appUrl,
  appInBrowserTab = false,
  busy,
  connection,
}: PreviewToolbarProps) {
  const busyReason = busy ? "Opening the selected view…" : undefined;
  const status =
    selected?.startsWith("app:") && appInBrowserTab
      ? "Ready to open in browser tab"
      : selected?.startsWith("app:")
        ? connection === "connected"
          ? "App loaded"
          : "Loading app…"
        : selected === "browser"
          ? connection === "connected"
            ? "Live browser frames"
            : connection === "disconnected"
              ? "No recent browser frames"
              : "Waiting for browser frames…"
          : connection === "connected"
            ? "Connected"
            : connection === "disconnected"
              ? "Disconnected"
              : "Connecting…";
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1 border-b px-2 py-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label="Open another preview"
              className="min-w-0 flex-1 justify-between"
              onClick={onOpenAnother}
            />
          }
        >
          <span className="truncate">
            {target
              ? workspacePreviewLabel(target)
              : selected?.startsWith("app:")
                ? `App · ${selected.slice(4)}`
                : selected === "screen"
                  ? "Virtual display"
                  : "Browser"}
          </span>
          <ChevronDown className="size-4 shrink-0" />
        </TooltipTrigger>
        <TooltipContent>Open another preview</TooltipContent>
      </Tooltip>
      {selected && (
        <Tooltip>
          <TooltipTrigger aria-label={status} className="inline-flex shrink-0 p-2">
            <span
              className={cn(
                "size-2 rounded-full",
                connection === "connected"
                  ? "bg-success"
                  : connection === "disconnected"
                    ? "bg-muted-foreground"
                    : "bg-warning",
              )}
            />
          </TooltipTrigger>
          <TooltipContent>{status}</TooltipContent>
        </Tooltip>
      )}
      <IconAction label="Refresh preview" disabled={busy} disabledReason={busyReason} onClick={onRefresh}>
        <RefreshCw />
      </IconAction>
      {selected && (
        <IconAction
          label={fullscreen ? "Exit full screen" : "Full screen"}
          onClick={onFullscreen}
          disabled={!fullscreenSupported}
          disabledReason="Your browser doesn't support full screen."
        >
          {fullscreen ? <Minimize2 /> : <Maximize2 />}
        </IconAction>
      )}
      {selected && (
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={busy}
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="More preview actions"
                disabled={busy}
                disabledReason={busyReason}
              />
            }
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              {appUrl && (
                <DropdownMenuItem render={<a href={appUrl} target="_blank" rel="noreferrer" />}>
                  <ExternalLink />
                  Open in browser tab
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={onDisconnect}>
                <Unplug />
                Close preview
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function IconAction({
  label,
  disabled,
  disabledReason,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  disabledReason?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const button = (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      disabled={disabled}
      disabledReason={disabledReason}
      onClick={onClick}
    >
      {children}
    </Button>
  );
  return disabled ? (
    button
  ) : (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
