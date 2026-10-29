import { cn } from "@internal/node-admin";
import { AppWindow, Globe } from "lucide-react";
import { badgeText, CountBadge } from "@/components/count-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { SubshellView } from "@/types/subshell";

export function VirtualDisplayIndicator({
  display,
  compact = false,
  unsavedCount = 0,
  hasLiveItems = false,
  canSave = true,
  onOpen,
}: {
  display?: string | null;
  compact?: boolean;
  /**
   * Items the picker could offer that this pane has no saved service for
   * (`unsavedPreviewItemCount`). A number sits on the icon so a pane doing
   * something previewable says so before anyone opens the picker.
   */
  unsavedCount?: number;
  /** Discovery confirms something this viewer can select, independently of saved rows. */
  hasLiveItems?: boolean;
  /**
   * Whether saving is among this reader's acts, which is `access !== "view"`.
   * The counted item for a view grantee is the browser watch: watching is theirs,
   * writing a Saved services row is not, so a number that reads "to open or
   * save" names a thing the picker will refuse them.
   */
  canSave?: boolean;
  onOpen?: () => void;
}) {
  if (!display && (compact || !onOpen)) return null;
  const label = `Virtual display ${display}`;
  if (compact)
    return (
      <span role="img" aria-label={label} className="relative inline-flex shrink-0 text-primary">
        <AppWindow className="size-3.5" aria-hidden="true" />
        {unsavedCount > 0 && <CountBadge count={unsavedCount} />}
      </span>
    );
  const count = unsavedCount > 0 ? `; ${badgeText(unsavedCount)} to open${canSave ? " or save" : ""}` : "";
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={`Open web preview or screen${count}`}
        aria-haspopup="dialog"
        onClick={onOpen}
        className={cn("relative inline-flex shrink-0 items-center", hasLiveItems ? "text-primary" : "text-foreground")}
      >
        {display ? (
          <AppWindow className="size-3.5" aria-hidden="true" />
        ) : (
          <Globe className="size-3.5" aria-hidden="true" />
        )}
        {unsavedCount > 0 && <CountBadge count={unsavedCount} />}
      </TooltipTrigger>
      <TooltipContent>
        {display ? "Virtual display enabled - click to activate" : "Open web preview or screen"}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The pane's ONE way into previews, which is what every surface that shows a
 * pane renders: the workspace header and the standalone subshell page both hand
 * this the pane and the count, and it derives the two things a reader must not
 * be shown wrong. `canSave` lives here rather than at each call site on
 * purpose: the counted item for a `view` grantee is the browser watch they can
 * open, never the Saved services row they cannot write, and a prop each caller
 * passes itself is a prop one caller forgets.
 */
export function VirtualDisplayEntry({
  subshell,
  unsavedCount,
  hasLiveItems,
  onOpen,
}: {
  /** The pane this header stands over, or nothing while its read is in flight. */
  subshell: SubshellView | undefined;
  /** Offered items this pane has no saved service for; see {@link VirtualDisplayIndicator}. */
  unsavedCount: number;
  hasLiveItems?: boolean;
  /** Opens the picker, which its caller mounts. */
  onOpen: () => void;
}) {
  return (
    <VirtualDisplayIndicator
      display={subshell?.virtualDisplay}
      unsavedCount={unsavedCount}
      hasLiveItems={hasLiveItems}
      canSave={subshell?.access !== "view"}
      onOpen={onOpen}
    />
  );
}
