import { useEffect } from "react";
import { useWaitingCount } from "@/hooks/use-summary";
import { setIconBadge } from "@/native/push";

/**
 * App-icon badge reconciliation (spec §Push acceptance: "badge equals the
 * waiting count"). The push payload stamps the icon at SEND time — true for
 * that instant only. While foregrounded the polled summary is the source of
 * truth, so every change rewrites the icon to match: events resolved, bells
 * silenced, sessions deleted, instances forgotten. Signed out, `waiting`
 * collapses to 0 and the badge clears with it. Mounted once by `PushBridge`.
 */
export function useIconBadge(): void {
  const waiting = useWaitingCount();
  useEffect(() => {
    void setIconBadge(waiting);
  }, [waiting]);
}
