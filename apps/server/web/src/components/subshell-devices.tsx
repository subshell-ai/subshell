import { describeDevices, roleLabel, type ViewersState } from "@internal/subshell-protocol";
import { Check, Monitor, Pin } from "lucide-react";
import type { JSX } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** Props for {@link SubshellDevices}. */
export interface SubshellDevicesProps {
  /** The latest `viewers` frame, or null while the socket is down. */
  state: ViewersState | null;
  /**
   * Applies a sizing choice (the terminal's `setSizing` handle).
   *
   * Whether this viewer MAY is not asked of the caller: the presence frame
   * already says, in `canInput` on this client's own entry, and that is the
   * same fact the server enforces. Deriving it here means a surface that has
   * no access field to hand — a workspace pane — cannot get the answer wrong,
   * and no caller can disagree with the server about it.
   */
  onSizing?: (mode: "auto" | "pinned", viewerId?: string | null) => void;
}

/**
 * "Devices (2)" — who else is watching this subshell, and which of them is the
 * reason the terminal is the size it is.
 *
 * A tmux pane has ONE grid, so every attached device constrains it: by default
 * the pane shrinks to the smallest one so nobody has to clip. That is the
 * right default and a baffling experience without this list — a 4K monitor
 * showing an 80-column pane has no other way to reveal the phone in another
 * room. From here the size can be pinned to one screen instead.
 *
 * Absent while alone: with one device there is nothing to explain and nothing
 * to choose between.
 */
export function SubshellDevices({ state, onSizing }: SubshellDevicesProps): JSX.Element | null {
  if (!state || state.viewers.length < 2) return null;
  const { rows, grid, settled } = describeDevices(state);
  const pinnedId = state.sizing.mode === "pinned" ? state.sizing.pinnedViewerId : null;
  // Sizing changes what everyone sees, so it is an `edit` act like typing. A
  // `view` grantee gets the list and inert rows; the server refuses the frame
  // either way, and this keeps the buttons honest about it.
  //
  // Reads `=== true`, so an entry that is missing or says nothing leaves the
  // control INERT. The server is the authority and would refuse the frame
  // regardless, so either direction is safe — but a control that quietly does
  // nothing is a better failure than one that looks disabled for an owner.
  const me = state.viewers.find((v) => v.id === state.you);
  const mayResize = me?.canInput === true ? onSizing : undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-muted-foreground text-xs"
            aria-label={`${state.viewers.length} devices watching this subshell`}
          />
        }
      >
        <Monitor className="h-3.5 w-3.5" />
        {state.viewers.length}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[17rem]">
        <div className="px-2 py-1.5 text-muted-foreground text-xs">
          {grid && settled ? (
            <>
              Pane is {grid.cols}×{grid.rows}
              {pinnedId ? " (pinned)" : " (sized so every device fits)"}
            </>
          ) : (
            "Measuring…"
          )}
        </div>
        <DropdownMenuSeparator />
        {rows.map(({ viewer, you, role }) => {
          const label = roleLabel(role);
          const isPinned = viewer.id === pinnedId;
          return (
            <DropdownMenuItem
              key={viewer.id}
              // Clicking a device pins the pane to it; clicking the pinned one
              // again releases it. Without a way back, pinning would be a
              // one-way door out of the default.
              onSelect={mayResize ? () => mayResize(isPinned ? "auto" : "pinned", viewer.id) : undefined}
              disabled={!mayResize}
              className="flex-col items-start gap-0.5"
            >
              <span className="flex w-full items-center gap-2">
                <Pin className={cn("h-3 w-3 shrink-0", isPinned ? "text-primary" : "text-transparent")} />
                <span className="truncate">{viewer.label}</span>
                {you && <span className="shrink-0 text-muted-foreground text-xs">(this device)</span>}
              </span>
              <span className="flex w-full items-center gap-2 pl-5 text-muted-foreground text-xs">
                {viewer.capacity ? `${viewer.capacity.cols}×${viewer.capacity.rows}` : "measuring…"}
                {label && <span>· {label}</span>}
                {!viewer.canInput && <span>· read-only</span>}
              </span>
            </DropdownMenuItem>
          );
        })}
        {mayResize && pinnedId && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => mayResize("auto", null)}>
              <Check className="h-3 w-3" /> Back to automatic
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
