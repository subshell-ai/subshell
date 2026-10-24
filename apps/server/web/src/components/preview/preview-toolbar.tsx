import { Button, cn } from "@internal/node-admin";
import { ExternalLink, Maximize2, Minimize2, MoreHorizontal, RefreshCw, Unplug } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type PreviewConnection = "connecting" | "connected" | "disconnected";
export interface PreviewWorkspaceControls {
  maximized: boolean;
  onToggleMaximize: () => void;
}
export interface PreviewToolbarProps {
  workspace?: PreviewWorkspaceControls;
  selected: string | null;
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

/** One toolbar owns viewer actions, leaving the panel to the picture. */
export function PreviewToolbar({
  workspace,
  selected,
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
  const fullscreenAction = (
    <DropdownMenuItem
      aria-disabled={!fullscreenSupported}
      onSelect={() => {
        if (fullscreenSupported) onFullscreen();
      }}
    >
      <Maximize2 />
      <span className="flex flex-col">
        <span>Full screen</span>
        {!fullscreenSupported && (
          <span className="text-detail text-muted-foreground">Your browser doesn't support full screen.</span>
        )}
      </span>
    </DropdownMenuItem>
  );
  return (
    <div className="flex min-w-0 shrink-0 items-center justify-end gap-1 border-b px-2 py-1.5">
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
      {workspace?.maximized && (
        <Button variant="ghost" size="sm" onClick={workspace.onToggleMaximize}>
          <Minimize2 className="size-4" aria-hidden />
          Restore pane
        </Button>
      )}
      {fullscreen && (
        <Button variant="ghost" size="sm" onClick={onFullscreen}>
          <Minimize2 className="size-4" aria-hidden />
          Exit full screen
        </Button>
      )}
      <IconAction label="Refresh preview" disabled={busy} disabledReason={busyReason} onClick={onRefresh}>
        <RefreshCw />
      </IconAction>
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
          <DropdownMenuContent
            align="end"
            container={
              fullscreen && document.fullscreenElement instanceof HTMLElement ? document.fullscreenElement : undefined
            }
          >
            <DropdownMenuGroup>
              {workspace && !workspace.maximized && (
                <DropdownMenuItem onSelect={workspace.onToggleMaximize}>
                  <Maximize2 />
                  Maximize pane
                </DropdownMenuItem>
              )}
              {!fullscreen &&
                (fullscreenSupported ? (
                  fullscreenAction
                ) : (
                  <Tooltip>
                    <TooltipTrigger render={fullscreenAction} />
                    <TooltipContent>Your browser doesn't support full screen.</TooltipContent>
                  </Tooltip>
                ))}
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
