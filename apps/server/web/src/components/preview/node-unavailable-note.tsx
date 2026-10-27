import type { PreviewInfo } from "@/hooks/use-subshell-preview";
import { nodeReasonLine } from "./port-list";

/**
 * The one line that explains a node which cannot serve previews, in the two
 * colours that mean different things here.
 *
 * **Gold is a switch**, and two producers name it: the plane's verdict from the
 * node's Web previews & screens row (`preview-disabled`), and the node's own
 * answer for the same row, which arrives named with its explanation attached
 * (`preview-node-off: turn on Preview for this node`). Hence the prefix match:
 * compared whole, the node's word falls to muted and the same setting reads
 * gold on one path and muted on the other.
 *
 * Muted is everything else. Offline, slow, held back on protocol, too old, and
 * the per-feature zeroes all answer "not right now", and colouring that gold
 * would promise a setting nobody can find. The per-feature words
 * (`web-previews-disabled`, `virtual-display-disabled`) name a sentence in
 * `nodeReasonLine` for the chooser's own call, which is not this component.
 */
const SWITCH_OFF_REASONS: readonly string[] = ["preview-disabled", "preview-node-off"];

/** Whether the note is describing a switch the person can turn. */
function isSwitchOff(reason: string | undefined): boolean {
  return reason !== undefined && SWITCH_OFF_REASONS.some((word) => reason.startsWith(word));
}

const ENABLE_GUIDE = "https://docs.subshell.sh/guides/preview#enable-web-previews-and-displays-on-the-machine";

export function NodeUnavailableNote({ info, className = "" }: { info: PreviewInfo; className?: string }) {
  const switchOff = isSwitchOff(info.reason);
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <p className={`text-detail ${switchOff ? "text-warning" : "text-muted-foreground"}`}>
        {nodeReasonLine(info.reason)}
      </p>
      {switchOff && (
        <a href={ENABLE_GUIDE} target="_blank" rel="noreferrer" className="text-detail text-warning underline">
          How to enable web previews and screens
        </a>
      )}
    </div>
  );
}
