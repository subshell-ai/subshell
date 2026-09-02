import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RotateCcw, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SessionActionsMenu } from "@/components/session-actions-menu";
import { RowStatusBadges, relativeElapsed } from "@/components/session-status";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { AUTO_RESTART_HELP, describeAutoRestart } from "@/lib/auto-restart";
import { SESSIONS_QUERY_KEY } from "@/lib/query-keys";
import { confirmDeleteSessions, confirmTerminateSessions } from "@/lib/session-confirmations";
import type { SessionView } from "@/types/session";

/**
 * Full session table with per-row actions (terminate / restart / delete) and
 * a bulk-actions bar over the selected rows. Each action loops the existing
 * per-session endpoints, then invalidates the sessions query so the
 * SSE-driven list and home page reflect the change.
 */
export function SessionManagerTable({ sessions }: { sessions: SessionView[] }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  // Drop selections that vanished (e.g. deleted via SSE while a bulk action ran).
  const selectedIds = selected.filter((id) => sessions.some((s) => s.id === id));

  const selectAllRef = useRef<HTMLInputElement>(null);
  const allSelected = sessions.length > 0 && selectedIds.length === sessions.length;
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedIds.length > 0 && !allSelected;
    }
  }, [selectedIds.length, allSelected]);

  const [lastBulkError, setLastBulkError] = useState<string | null>(null);

  async function runBulk(action: "terminate" | "restart" | "delete") {
    const n = selectedIds.length;
    // Bulk terminate and delete are destructive and ask; bulk restart does
    // not (it spawns sessions and resumes conversations — nothing is lost).
    const ok =
      action === "restart"
        ? true
        : action === "terminate"
          ? await confirmTerminateSessions(n)
          : await confirmDeleteSessions(n);
    if (!ok) return;
    setBulkBusy(true);
    setLastBulkError(null);
    try {
      // Loop the existing per-session endpoints for the selected rows.
      const perId =
        action === "delete" ? (id: string) => `/api/sessions/${id}` : (id: string) => `/api/sessions/${id}/${action}`;
      const method = action === "delete" ? ("DELETE" as const) : ("POST" as const);
      const results = await Promise.allSettled(selectedIds.map((id) => apiFetch(perId(id), { method })));
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed.length > 0) {
        setLastBulkError(
          `${failed.length} of ${results.length} ${action} call${failed.length === 1 ? "" : "s"} failed`,
        );
      }
      await queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      setSelected([]);
    } finally {
      setBulkBusy(false);
    }
  }

  function toggle(id: string, checked: boolean) {
    setSelected((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)));
  }

  return (
    <div className="space-y-3">
      {lastBulkError && <p className="text-destructive text-sm">{lastBulkError}</p>}
      {selectedIds.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="mr-2 text-muted-foreground text-sm">{selectedIds.length} selected</span>
          <Button variant="destructive" size="sm" onClick={() => void runBulk("terminate")} disabled={bulkBusy}>
            <Square className="fill-current" /> Terminate
          </Button>
          <Button variant="outline" size="sm" onClick={() => void runBulk("restart")} disabled={bulkBusy}>
            <RotateCcw /> Restart
          </Button>
          <Button variant="destructive" size="sm" onClick={() => void runBulk("delete")} disabled={bulkBusy}>
            <Trash2 /> Delete
          </Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-muted-foreground text-xs uppercase">
              <th className="w-9 px-3 py-2.5">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  aria-label="Select all sessions"
                  className="h-4 w-4 rounded border border-input bg-background accent-primary"
                  checked={allSelected}
                  onChange={(e) => setSelected(e.target.checked ? sessions.map((s) => s.id) : [])}
                />
              </th>
              <th className="px-3 py-2.5 text-left font-medium">Name</th>
              <th className="px-3 py-2.5 text-left font-medium">Status</th>
              <th className="px-3 py-2.5 text-left font-medium">Working dir</th>
              <th className="px-3 py-2.5 text-left font-medium">Last output</th>
              <th className="px-3 py-2.5 text-left font-medium">Uptime</th>
              <th className="px-3 py-2.5 text-left font-medium" title={AUTO_RESTART_HELP}>
                Auto-restart
              </th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {sessions.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                  No sessions yet.
                </td>
              </tr>
            ) : (
              sessions.map((s) => {
                // Same `=== true` posture as RowStatusBadges: with the agent
                // down, lastOutputAt/startedAt/alive are last-known facts, so
                // the two time cells must not assert from them (spec §5.6) —
                // "—" is this table's existing nothing-to-say idiom.
                const offline = s.nodeOffline === true;
                return (
                  <tr key={s.id} className="border-b last:border-0 hover:bg-accent/40">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Select session ${s.name}`}
                        className="h-4 w-4 rounded border border-input bg-background accent-primary"
                        checked={selectedIds.includes(s.id)}
                        onChange={(e) => toggle(s.id, e.target.checked)}
                      />
                    </td>
                    <td className="max-w-[200px] truncate px-3 py-2">
                      <Link to="/sessions/$id" params={{ id: s.id }} className="font-medium hover:text-primary">
                        {s.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <RowStatusBadges session={s} />
                      </div>
                    </td>
                    <td className="max-w-[240px] truncate px-3 py-2 text-muted-foreground">{s.workingDir}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {offline ? "—" : s.lastOutputAt ? `${relativeElapsed(s.lastOutputAt)} ago` : "—"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {!offline && s.status === "running" && s.alive && s.startedAt
                        ? relativeElapsed(s.startedAt)
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground" title={AUTO_RESTART_HELP}>
                      {describeAutoRestart(s, relativeElapsed)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end">
                        <SessionActionsMenu session={s} disabled={bulkBusy} />
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
