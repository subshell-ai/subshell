import { AppWindow } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function VirtualDisplayIndicator({
  display,
  compact = false,
  onOpen,
}: {
  display?: string | null;
  compact?: boolean;
  onOpen?: () => void;
}) {
  if (!display) return null;
  const label = `Virtual display ${display}`;
  if (compact)
    return (
      <span role="img" aria-label={label} className="inline-flex shrink-0 text-primary">
        <AppWindow className="size-3.5" aria-hidden="true" />
      </span>
    );
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label="Open preview"
        aria-haspopup="dialog"
        onClick={onOpen}
        className="inline-flex shrink-0 items-center text-primary"
      >
        <AppWindow className="size-3.5" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>Virtual display enabled - click to activate</TooltipContent>
    </Tooltip>
  );
}
