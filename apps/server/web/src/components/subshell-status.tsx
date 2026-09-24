import { Badge } from "@internal/node-admin";
import { WaitingChip } from "@/components/waiting-chip";
import { isWaiting } from "@/lib/subshell-order";
import type { SubshellView } from "@/types/subshell";

/* relativeElapsed moved to `@internal/node-admin` with the node cards that
   stamp "in maintenance since …" with it; import it from there. */

/**
 * Status chip: running (alive), paused/exited, or terminated.
 *
 * Lives in the workspace add-subshell dialog. The home list view and the
 * cards dropped these chips for the status dot (2026-09-24) — the picker
 * keeps the words because a person choosing a pane to add needs the state
 * at a glance, not a hover.
 */
export function StatusChip({ subshell }: { subshell: SubshellView }) {
  if (subshell.status === "terminated") return <Badge variant="muted">ended</Badge>;
  if (!subshell.alive) return <Badge variant="muted">exited</Badge>;
  return <Badge variant="success">running</Badge>;
}

/**
 * The status badges for one subshell ROW: {@link StatusChip} plus the
 * "waiting for you" chip — except when the subshell's node is unreachable,
 * where the red `node unreachable` badge replaces BOTH (red, not warning
 * amber, since 2026-09-24: the dot says offline in the palette's error red,
 * and one state does not get two colours on two surfaces).
 *
 * Node-offline outranks everything because with the node down,
 * `alive`/`waitingSince` are last-known facts, not current state (spec
 * 2026-08-31 §5.6): claiming "running" (or "ended"/"exited") or "waiting for
 * you" would assert from stale DB truth. The status dot (used by the cards,
 * the list and the rail) implements the SAME precedence through
 * `subshellIndicator` — see lib/subshell-indicator.ts. `=== true` matches
 * that helper's posture: older payloads without the field read online-ish.
 */
export function RowStatusBadges({ subshell }: { subshell: SubshellView }) {
  if (subshell.nodeOffline === true) return <Badge variant="destructive">node unreachable</Badge>;
  return (
    <>
      <StatusChip subshell={subshell} />
      {isWaiting(subshell) && <WaitingChip subshell={subshell} />}
    </>
  );
}
