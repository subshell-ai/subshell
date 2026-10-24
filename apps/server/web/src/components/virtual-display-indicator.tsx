import { Monitor } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function VirtualDisplayIndicator({ display, compact = false }: { display?: string | null; compact?: boolean }) {
  if (!display) return null;
  const label = `Virtual display ${display}`;
  if (compact)
    return (
      <span role="img" aria-label={label} className="inline-flex shrink-0 text-primary">
        <Monitor className="size-3.5" aria-hidden="true" />
      </span>
    );
  return (
    <Tooltip>
      <TooltipTrigger aria-label={label} className="inline-flex shrink-0 items-center gap-1.5 text-detail text-primary">
        <Monitor className="size-3.5" aria-hidden="true" />
        {!compact && <span aria-hidden="true">Virtual display</span>}
      </TooltipTrigger>
      <TooltipContent>
        This subshell has a virtual display. Open Preview, then View screen to see its graphical apps.
      </TooltipContent>
    </Tooltip>
  );
}
