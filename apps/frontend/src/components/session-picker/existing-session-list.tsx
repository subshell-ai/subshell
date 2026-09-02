import type { JSX } from "react";
import { SessionSearch } from "@/components/session-search";
import { RowStatusBadges, relativeElapsed } from "@/components/session-status";
import { filterSessions } from "@/lib/session-filter";
import { priorityRunning } from "@/lib/session-order";
import type { SessionView } from "@/types/session";

/**
 * The searchable list of sessions that can be added to a workspace.
 *
 * This replaces three parallel dropdown submenus, which listed every session
 * three times with no way to search: fine for four sessions, unusable for
 * forty. It searches with `filterSessions` and shows status with
 * `RowStatusBadges` — the `StatusChip` state plus the `WaitingChip` "waiting
 * for you" badge, or a lone "node unreachable" badge replacing both when the
 * session's node is offline (spec 2026-08-31 §5.6) — the same pieces the
 * sessions page uses, so a session reads the same here as it does there.
 * Bell-on waiting sessions sort to the top via `priorityRunning`.
 */
export function ExistingSessionList({
  sessions,
  nodeId,
  query,
  onQueryChange,
  loadFailed,
  loading,
  onPick,
  busyId,
}: {
  /** Sessions not already on this workspace. */
  sessions: SessionView[];
  /**
   * When set, only sessions running on this node are listed — the dialog
   * keeps the EXISTING half coherent with the node the NEW half would
   * launch onto. Pure display filtering: the list is already visibility-
   * filtered server-side and this must never be relied on for authz.
   * Older payloads without `nodeId` are treated as `local`.
   */
  nodeId?: string;
  /** Current search text. */
  query: string;
  /** Called as the search text changes. */
  onQueryChange: (query: string) => void;
  /** True when the sessions list itself failed to load — distinct from a genuinely empty list. */
  loadFailed: boolean;
  /**
   * True while the sessions list is still loading — an empty list then says
   * nothing about the workspace, so claiming "every session is already here"
   * would be a lie about data the dialog hasn't seen yet.
   */
  loading: boolean;
  /** Adds the picked session. */
  onPick: (sessionId: string) => void;
  /** Id of the session currently being added, if any. */
  busyId: string | null;
}): JSX.Element {
  const onNode = nodeId === undefined ? sessions : sessions.filter((s) => (s.nodeId ?? "local") === nodeId);
  const filtered = priorityRunning(filterSessions(onNode, query));

  return (
    <div className="space-y-3">
      <SessionSearch value={query} onChange={onQueryChange} />

      <div className="max-h-80 min-h-32 overflow-y-auto rounded-md border">
        {loadFailed ? (
          <p className="p-3 text-destructive text-sm">Couldn't load sessions.</p>
        ) : loading ? (
          <p className="p-3 text-muted-foreground text-sm">Loading sessions…</p>
        ) : sessions.length === 0 ? (
          <p className="p-3 text-muted-foreground text-sm">
            Every session is already on this workspace. Create a new one instead.
          </p>
        ) : onNode.length === 0 ? (
          <p className="p-3 text-muted-foreground text-sm">
            No sessions on this node. Use “New session” to launch one there, or pick a different node there to list
            those sessions.
          </p>
        ) : filtered.length === 0 ? (
          <p className="p-3 text-muted-foreground text-sm">No sessions match “{query}”.</p>
        ) : (
          <ul>
            {filtered.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => onPick(session.id)}
                  className="flex w-full items-center gap-3 border-b px-3 py-2 text-left last:border-b-0 hover:bg-accent disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-sm">{session.name}</span>
                    <span className="block truncate font-mono text-muted-foreground text-xs">{session.workingDir}</span>
                  </span>
                  <span className="shrink-0 text-muted-foreground text-xs">{session.harnessId}</span>
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {session.lastOutputAt ? relativeElapsed(session.lastOutputAt) : "—"}
                  </span>
                  <RowStatusBadges session={session} />
                  {busyId === session.id && <span className="shrink-0 text-muted-foreground text-xs">Adding…</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
