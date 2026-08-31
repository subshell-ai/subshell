import { Badge } from "@/components/ui/badge";
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
