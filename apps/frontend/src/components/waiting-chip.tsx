import { Badge } from "@/components/ui/badge";
import { isWaiting } from "@/lib/session-order";
import type { SessionView } from "@/types/session";

/**
 * Amber "waiting for you" chip: the session stopped producing output while
 * its turn finished or an approval is pending (stamped server-side by the
 * attention watcher).
 *
 * Self-guarding — renders nothing unless {@link isWaiting} holds, so call
 * sites can drop it into a cell unconditionally.
 */
export function WaitingChip({ session }: { session: SessionView }) {
  if (!isWaiting(session)) return null;
  return <Badge variant="warning">waiting for you</Badge>;
}
