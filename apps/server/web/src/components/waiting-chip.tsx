import { Badge } from "@internal/node-admin";
import { isWaiting } from "@/lib/subshell-order";
import type { SubshellView } from "@/types/subshell";

/**
 * Amber "waiting for you" chip: the subshell stopped producing output while
 * its turn finished or an approval is pending (stamped server-side by the
 * attention watcher).
 *
 * Self-guarding — renders nothing unless {@link isWaiting} holds, so call
 * sites can drop it into a cell unconditionally.
 */
export function WaitingChip({ subshell }: { subshell: SubshellView }) {
  if (!isWaiting(subshell)) return null;
  return <Badge variant="warning">waiting for you</Badge>;
}
