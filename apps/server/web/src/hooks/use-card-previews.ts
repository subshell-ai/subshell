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
  // Capped here rather than left to the server's own ceiling, which TRUNCATES
  // silently — past it the tail of the list would simply never get a screen
  // and nothing would say why. Asking for fewer is honest: each id is a
  // `capture-pane` spawn, and a page showing hundreds of cards is not a page
  // whose every screen a person is reading.
  const key = [...ids].sort().slice(0, MAX_CARD_PREVIEWS).join(",");
  useEffect(() => {
    if (!connected) return; // nothing to ask yet; the connect will re-ask
    requestPreviews(key === "" ? [] : key.split(","));
  }, [key, connected, requestPreviews]);
}

/**
 * Most screens one page asks for at a time.
 *
 * Must stay at or below the server's `MAX_PREVIEW_REQUEST`, which truncates
 * without telling anyone; keeping this the smaller number is what makes that
 * truncation unreachable in practice.
 */
export const MAX_CARD_PREVIEWS = 40;
