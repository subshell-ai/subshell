import { useSyncExternalStore } from "react";
import { getServerSnapshot, subscribeServerStatus } from "@/lib/server-status";

/** True while the shared query cache shows any active query stuck on a
 * network error — i.e. the subshell server is unreachable and retrying. */
export function useServerOffline(): boolean {
  return useSyncExternalStore(subscribeServerStatus, getServerSnapshot, getServerSnapshot);
}
