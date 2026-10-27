import { AppWindow, Globe } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Above this the badge says `9+`; the exact list is the picker's job. */
const BADGE_CAP = 9;

/** The count's one spelling: `9+` past the cap, so the painted chip and the
 *  announced name can never disagree about how many there are. */
export function badgeText(count: number): string {
  return count > BADGE_CAP ? "9+" : String(count);
}

export function VirtualDisplayIndicator({
  display,
  compact = false,
  unsavedCount = 0,
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
        {unsavedCount > 0 && <PreviewBadge count={unsavedCount} />}
      </span>
    );
  const count = unsavedCount > 0 ? `; ${badgeText(unsavedCount)} to open${canSave ? " or save" : ""}` : "";
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={`Open web preview or screen${count}`}
        aria-haspopup="dialog"
        onClick={onOpen}
        className="relative inline-flex shrink-0 items-center text-primary"
      >
        {display ? (
          <AppWindow className="size-3.5" aria-hidden="true" />
        ) : (
          <Globe className="size-3.5" aria-hidden="true" />
        )}
        {unsavedCount > 0 && <PreviewBadge count={unsavedCount} />}
      </TooltipTrigger>
      <TooltipContent>
        {display ? "Virtual display enabled - click to activate" : "Open web preview or screen"}
      </TooltipContent>
    </Tooltip>
  );
}

/** The count chip. Decorative: the trigger's aria-label already carries it. */
function PreviewBadge({ count }: { count: number }) {
  return (
    <span
      aria-hidden="true"
      className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-strong text-detail text-primary-foreground"
    >
      {badgeText(count)}
    </span>
  );
}
