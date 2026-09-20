import { apiFetch, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@internal/node-admin";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

/** One recorded event: who did what to which target, and when. */
interface AuditEvent {
  /** Unique event id */
  id: string;
  /** The acting user, or null for a system-originated event */
  actorUserId: string | null;
  /** Machine-readable action name, e.g. `user.create` */
  action: string;
  /** What kind of thing was acted on (`subshell`, `user`, …), or null */
  targetType: string | null;
  /** Id of the target, rendered truncated beside its type */
  targetId: string | null;
  /** Free-form per-action context, serialized for display */
  metadata: unknown;
  /** ISO 8601 timestamp */
  createdAt: string;
}

/** Events per page. The server has its own cap; this is the card's. */
const PAGE_SIZE = 25;

/** The `(createdAt, id)` pair the server pages BEFORE — one row, total order. */
interface Cursor {
  /** ISO 8601 timestamp of the OLDEST row on the page this cursor ends */
  createdAt: string;
  /** Id tie-break of that same row */
  id: string;
}

/** The audit trail's own query key. `null` is the newest page. */
function auditKey(cursor: Cursor | null) {
  return ["audit", cursor];
}

/**
 * The instance's audit trail — every recorded event, newest first, one page
 * of {@link PAGE_SIZE} at a time.
 *
 * Lived on `/users` until the admin surface was split into named pages
 * (spec 2026-09-11 §4.4), then owned `/settings/audit`, and is the Audit tab
 * of `/settings/logs` since 2026-09-20. The caller owns the admin gate, so
 * the query here is unconditional: the route renders this card only inside
 * its admin branch.
 *
 * **Pagination is keyset, not offset** (`beforeCreatedAt`/`beforeId` = the
 * oldest row of the page above, matching the route's `(createdAt desc,
 * id desc)` order — a pair because two events can share a millisecond and a
 * one-column cursor would skip or repeat the tie). The card stacks the
 * cursors it has stepped through, so Newer walks back up the stack and each
 * page keeps its own query key; "page 3" is not "the 50 rows after wherever
 * the trail grew since you arrived", which offset would give on an
 * append-only table.
 *
 * `staleTime: 0` is load-bearing, not a default restated. Mounting this page
 * is the ONLY thing that refreshes the trail — `/users` used to invalidate
 * `["audit"]` on every role change and password reset, and it no longer holds
 * the table to invalidate for. The client's global `staleTime` is 10 s
 * (`lib/query-client.ts`), so without this an admin who resets a password and
 * comes straight here is served the cache and sees no record of what they
 * just did. This is also the one read-only admin page with no Refresh control
 * (`/settings/status` has a button and a 15 s interval), so a stale first
 * paint has nothing to correct it.
 */
export function AuditTrailCard() {
  // The cursor stack: index = page number - 1, entry = the `before` pair that
  // page was fetched with, `[null]` = the newest page. Paging Older pushes
  // the pair built from the current page's last row; Newer pops.
  const [pages, setPages] = useState<(Cursor | null)[]>([null]);
  const pageIndex = pages.length - 1;
  const cursor = pages[pageIndex];

  const {
    data: auditEvents,
    isError: auditIsError,
    isLoading: auditIsLoading,
  } = useQuery({
    queryKey: auditKey(cursor),
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) {
        params.set("beforeCreatedAt", cursor.createdAt);
        params.set("beforeId", cursor.id);
      }
      return apiFetch<AuditEvent[]>(`/api/audit?${params.toString()}`);
    },
    staleTime: 0,
    retry: false,
  });

  // A short page is the server saying there is nothing older — the trail has
  // no total count, and inventing one would mean a second query per read.
  const hasOlder = (auditEvents?.length ?? 0) === PAGE_SIZE;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit trail</CardTitle>
        <CardDescription>Subshell lifecycle and admin events, newest first.</CardDescription>
      </CardHeader>
      <CardContent>
        {/* Error ≠ empty ≠ loading — the /users roster got this treatment
            first; the trail follows its vocabulary. */}
        {auditIsError ? (
          <p className="text-muted-foreground text-sm">
            Couldn&apos;t load the audit trail. Check your connection or sign in again.
          </p>
        ) : auditIsLoading ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : !auditEvents?.length ? (
          <p className="text-muted-foreground text-sm">No events recorded yet.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pr-4 pb-2 font-strong">When</th>
                    <th className="pr-4 pb-2 font-strong">Action</th>
                    <th className="pr-4 pb-2 font-strong">Target</th>
                    <th className="pb-2 font-strong">Context</th>
                  </tr>
                </thead>
                <tbody>
                  {auditEvents.map((e) => (
                    <tr key={e.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</td>
                      <td className="py-2 pr-4 font-mono text-detail">{e.action}</td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {e.targetType ? `${e.targetType}:${e.targetId?.slice(0, 8)}` : "—"}
                      </td>
                      <td className="py-2 text-muted-foreground">{JSON.stringify(e.metadata ?? {})}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Nothing to page through yet: one short page IS the whole
                trail, and a pager that can do neither thing is chrome. */}
            {pageIndex === 0 && !hasOlder ? null : (
              <div className="mt-4 flex items-center justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pageIndex === 0}
                  onClick={() => setPages((p) => p.slice(0, -1))}
                >
                  Newer
                </Button>
                <span className="text-detail text-muted-foreground">Page {pageIndex + 1}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!hasOlder}
                  onClick={() => {
                    const last = auditEvents[auditEvents.length - 1];
                    setPages((p) => [...p, { createdAt: last.createdAt, id: last.id }]);
                  }}
                >
                  Older
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
