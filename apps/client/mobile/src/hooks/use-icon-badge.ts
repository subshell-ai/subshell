import { useEffect } from "react";
import { useWaitingState } from "@/hooks/use-summary";
import { setIconBadge } from "@/native/push";
import { useSubshell } from "@/providers/subshell-provider";

/**
 * App-icon badge reconciliation (spec §Push acceptance: "badge equals the
 * waiting count" — OF THE ACTIVE INSTANCE; pushes carry other instances'
 * send-time counts and the poll only sees this one, review #3). The push
 * payload stamps the icon at SEND time — true for that instant only. While
 * foregrounded the polled summary is the source of truth, so every settled
 * change rewrites the icon to match: events resolved, bells silenced,
 * subshells deleted, instances forgotten.
 *
 * Two deliberate gates (review, Important #1/#2):
 * - signed-in but first poll not settled → DON'T write. The badge APNs
 *   stamped while the app was killed is what the user glances at; writing
 *   the empty-array fallback would flash it to 0 until the first response.
 * - signed out → 0, unconditionally (no client, nothing to wait for).
 * The foreground presentation handler returns shouldSetBadge:false so the
 * poll loop is the icon's ONLY writer while the app can see the truth.
 */
export function useIconBadge(): void {
  const { client } = useSubshell();
  const { waiting, loading } = useWaitingState();
  useEffect(() => {
    if (!client) {
      void setIconBadge(0);
      return;
    }
    if (loading) return;
    void setIconBadge(waiting);
  }, [client, loading, waiting]);
}
