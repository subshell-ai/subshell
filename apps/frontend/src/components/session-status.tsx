import { Badge } from "@/components/ui/badge";
import { WaitingChip } from "@/components/waiting-chip";
import { isWaiting } from "@/lib/session-order";
import type { SessionView } from "@/types/session";

/**
 * Compact relative time (e.g. "5m", "2h", "3d").
 *
 * No seconds: the SSE feed re-renders these lists on every tick, and a
 * second-by-second value would churn without telling anyone anything.
 */
export function relativeElapsed(iso: string): string {
  const ms = Date.parse(iso);
  const secs = Math.abs(Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * Status chip: running (alive), paused/exited, or terminated.
 *
 * Shared by the sessions list view and the workspace add-session dialog so
 * one session never reads as two different states in two places.
 */
export function StatusChip({ session }: { session: SessionView }) {
  if (session.status === "terminated") return <Badge variant="muted">ended</Badge>;
  if (!session.alive) return <Badge variant="muted">exited</Badge>;
  return <Badge variant="success">running</Badge>;
}

/**
 * The status badges for one session ROW: {@link StatusChip} plus the
 * "waiting for you" chip — except when the session's node is unreachable,
 * where the amber `node unreachable` badge replaces BOTH.
 *
 * Node-offline outranks everything because with the agent down,
 * `alive`/`waitingSince` are last-known facts, not current state (spec
 * 2026-08-31 §5.6): claiming "running" (or "ended"/"exited") or "waiting for
 * you" would assert from stale DB truth. The card implements the same
 * precedence for its corner badge — see `accessoryFor` in session-card.tsx,
 * the sibling for that affordance (kept separate because the card also
 * weighs `exited` and the activity labels). `=== true` matches that
 * helper's posture: older payloads without the field read online-ish.
 */
export function RowStatusBadges({ session }: { session: SessionView }) {
  if (session.nodeOffline === true) return <Badge variant="warning">node unreachable</Badge>;
  return (
    <>
      <StatusChip session={session} />
      {isWaiting(session) && <WaitingChip session={session} />}
    </>
  );
}
