import { hasActivity, pollIntervalMs } from "@/lib/poll-policy";
import type { SessionView } from "@/types/session";

/**
 * The one TanStack adapter for the poll policy (spec §Transport): every polled
 * query returns this from `refetchInterval` so 3 s/15 s/background-stop means
 * the same thing everywhere. `rows` is the activity source for the tick —
 * each hook passes its own data (or, for the badge, the list's).
 */
export function polledInterval(foreground: boolean, rows: () => SessionView[] | undefined): number | false {
  return pollIntervalMs({ foreground, hasActivity: hasActivity(rows() ?? []) }) ?? false;
}
