import type { PreviewInfo } from "@/hooks/use-subshell-preview";
import { nodeReasonLine } from "./port-list";

/** Node switches share the same enablement guide; offline states do not. */
export function isSwitchOff(reason: string | undefined): boolean {
  return (
    reason === "preview-disabled" ||
    reason === "web-previews-disabled" ||
    reason === "virtual-display-disabled" ||
    reason?.startsWith("preview-node-off") === true
  );
}

const ENABLE_GUIDE = "https://docs.subshell.sh/previews/setup";

function unavailableReasons(info: PreviewInfo): Set<string> {
  const reasons = new Set<string>();
  if (info.reason) reasons.add(info.reason);
  if (info.nodeEnabled && !isSwitchOff(info.reason)) {
    if (info.webPreviewsEnabled === false) reasons.add("web-previews-disabled");
    if (info.virtualDisplayEnabled === false) reasons.add("virtual-display-disabled");
  }
  return reasons;
}

/** Match the enablement note's full verdict, including per-feature switches. */
export function hasDisabledPreviewFeature(info: PreviewInfo | undefined): boolean {
  return !!info && [...unavailableReasons(info)].some(isSwitchOff);
}

export function NodeUnavailableNote({ info, className = "" }: { info: PreviewInfo; className?: string }) {
  const reasons = unavailableReasons(info);
  if (info.nodeEnabled && reasons.size === 0) return null;
  const switchOff = [...reasons].some(isSwitchOff);
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {(reasons.size ? [...reasons] : [undefined]).map((reason) => (
        <p
          key={reason ?? "unavailable"}
          className={`text-detail ${isSwitchOff(reason) ? "text-warning" : "text-muted-foreground"}`}
        >
          {nodeReasonLine(reason)}
        </p>
      ))}
      {switchOff && (
        <a href={ENABLE_GUIDE} target="_blank" rel="noreferrer" className="text-detail text-warning underline">
          How to enable web previews and screens
        </a>
      )}
    </div>
  );
}
