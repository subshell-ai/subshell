import { useEffect } from "react";
import { useLiveSubshellsFeed } from "@/hooks/use-live-subshells-feed";

/**
 * Asks the live socket for the screens of the cards currently on screen.
 *
 * Previews are PULLED rather than pushed (spec 2026-09-19 §4.4). The snapshot
 * carries none, because capturing a pane costs a `capture-pane` spawn each and
 * the cards are the only surface that renders one — every other page would
 * have been paying for screens it does not draw. So the page that draws them
 * asks, and the feed re-pulls a card's screen when a change arrives for it.
 *
 * Re-asks whenever the SET changes, not whenever the array identity does:
 * the list is rebuilt on every filter keystroke, and a request per keystroke
 * would put the capture cost back in a worse place than the timer it replaced.
 *
 * @param ids - the subshell ids being rendered as cards, in any order
 */
export function useCardPreviews(ids: string[]): void {
  const { requestPreviews, connected } = useLiveSubshellsFeed();
  // A stable key over the SET: order is irrelevant to what must be captured.
  const key = [...ids].sort().join(",");
  useEffect(() => {
    if (!connected) return; // nothing to ask yet; the connect will re-ask
    requestPreviews(key === "" ? [] : key.split(","));
  }, [key, connected, requestPreviews]);
}
