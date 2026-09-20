import { Badge } from "@internal/node-admin";
import { WaitingChip } from "@/components/waiting-chip";
import { isWaiting } from "@/lib/subshell-order";
import type { SubshellView } from "@/types/subshell";

/* relativeElapsed moved to `@internal/node-admin` with the node cards that
   stamp "in maintenance since …" with it; import it from there. */

/**
 * Status chip: running (alive), paused/exited, or terminated.
 *
 * Shared by the subshells list view and the workspace add-subshell dialog so
 * one subshell never reads as two different states in two places.
 */
export function StatusChip({ subshell }: { subshell: SubshellView }) {
  if (subshell.status === "terminated") return <Badge variant="muted">ended</Badge>;
  if (!subshell.alive) return <Badge variant="muted">exited</Badge>;
  return <Badge variant="success">running</Badge>;
}

/**
 * The status badges for one subshell ROW: {@link StatusChip} plus the
 * "waiting for you" chip — except when the subshell's node is unreachable,
 * where the amber `node unreachable` badge replaces BOTH.
 *
 * Node-offline outranks everything because with the node down,
 * `alive`/`waitingSince` are last-known facts, not current state (spec
 * 2026-08-31 §5.6): claiming "running" (or "ended"/"exited") or "waiting for
 * you" would assert from stale DB truth. The card implements the same
 * precedence for its corner badge — see `accessoryFor` in subshell-card.tsx,
 * the sibling for that affordance (kept separate because the card also
 * weighs `exited` and the activity labels). `=== true` matches that
 * helper's posture: older payloads without the field read online-ish.
 */
export function RowStatusBadges({ subshell }: { subshell: SubshellView }) {
  if (subshell.nodeOffline === true) return <Badge variant="warning">node unreachable</Badge>;
  return (
    <>
      <StatusChip subshell={subshell} />
      {isWaiting(subshell) && <WaitingChip subshell={subshell} />}
    </>
  );
}
