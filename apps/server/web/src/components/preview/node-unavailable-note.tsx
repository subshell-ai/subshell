import type { PreviewInfo } from "@/hooks/use-subshell-preview";
import { nodeReasonLine } from "./port-list";

/**
 * The one line that explains a node which cannot serve previews, in the two
 * colours that mean different things here.
 *
 * **Gold is a switch.** `preview-disabled` is the node's own Web previews &
 * screens setting (the master switch), and the two per-feature words are its
 * halves. Nothing about the machine or the network is wrong: someone with
 * access to that node's settings can turn this on, and the guide says how.
 * Muted is everything else: a node that is offline, slow, held back on
 * protocol, or too old answers the same question ("not right now"), and
 * colouring that gold would read as a setting nobody can find.
 */
const SWITCH_OFF_REASONS: readonly string[] = ["preview-disabled", "web-previews-disabled", "virtual-display-disabled"];

const ENABLE_GUIDE = "https://docs.subshell.sh/guides/preview#enable-web-previews-and-displays-on-the-machine";

export function NodeUnavailableNote({ info, className = "" }: { info: PreviewInfo; className?: string }) {
  const switchOff = SWITCH_OFF_REASONS.includes(info.reason ?? "");
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
