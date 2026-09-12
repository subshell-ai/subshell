import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetch } from "@/lib/api";

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

/**
 * The instance's audit trail — the latest 50 events, read-only.
 *
 * Lived on `/users` until the admin surface was split into named pages
 * (spec 2026-09-11 §4.4); it is the whole body of `/settings/audit` now. The
 * caller owns the admin gate, so the query here is unconditional: the route
 * renders this card only inside its admin branch.
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
  const {
    data: auditEvents,
    isError: auditIsError,
    isLoading: auditIsLoading,
  } = useQuery({
    queryKey: ["audit"],
    queryFn: () => apiFetch<AuditEvent[]>("/api/audit?limit=50"),
    staleTime: 0,
    retry: false,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit trail</CardTitle>
        <CardDescription>Latest subshell lifecycle and admin events.</CardDescription>
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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pr-4 pb-2 font-medium">When</th>
                  <th className="pr-4 pb-2 font-medium">Action</th>
                  <th className="pr-4 pb-2 font-medium">Target</th>
                  <th className="pb-2 font-medium">Context</th>
                </tr>
              </thead>
              <tbody>
                {auditEvents.map((e) => (
                  <tr key={e.id} className="border-b last:border-0">
                    <td className="py-2 pr-4 text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{e.action}</td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {e.targetType ? `${e.targetType}:${e.targetId?.slice(0, 8)}` : "—"}
                    </td>
                    <td className="py-2 text-muted-foreground">{JSON.stringify(e.metadata ?? {})}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
