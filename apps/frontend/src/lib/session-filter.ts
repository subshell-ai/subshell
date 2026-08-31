import type { SessionView } from "@/types/session";

/**
 * Filters sessions by a free-text query against name, working directory and
 * harness — the three things people actually recognise a session by.
 *
 * Shared so every place that searches sessions searches them identically:
 * the sessions page and the workspace's add-session dialog. An empty or
 * whitespace query returns the input unchanged (the same array, not a copy).
 */
export function filterSessions(sessions: SessionView[], query: string): SessionView[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.workingDir.toLowerCase().includes(q) ||
      s.harnessId.toLowerCase().includes(q),
  );
}

/** Sessions grouped by what an operator treats as distinct states. */
export interface SessionGroups {
  /** Status "running" and the process is alive. */
  running: SessionView[];
  /** Status "running" but the process exited — resumable. */
  exited: SessionView[];
  /** Status "terminated". */
  terminated: SessionView[];
}

/**
 * Splits sessions into running / paused-exited / terminated.
 *
 * "Running but not alive" is its own group rather than a variant of either
 * neighbour: the row still exists and can be restarted, which is not true of
 * a terminated one.
 */
export function groupSessions(sessions: SessionView[]): SessionGroups {
  return {
    running: sessions.filter((s) => s.status === "running" && s.alive),
    exited: sessions.filter((s) => s.status === "running" && !s.alive),
    terminated: sessions.filter((s) => s.status === "terminated"),
  };
}
