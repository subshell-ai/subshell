import { apiFetch, Button, relativeElapsed } from "@internal/node-admin";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SubshellActionsMenu } from "@/components/subshell-actions-menu";
import { RowStatusBadges } from "@/components/subshell-status";
import { AUTO_RESTART_HELP, describeAutoRestart } from "@/lib/auto-restart";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import { confirmCloseSubshells } from "@/lib/subshell-confirmations";
import type { SubshellView } from "@/types/subshell";

/**
 * Full subshell table with per-row actions (restart / close — the ⋯ menu) and
 * a bulk-actions bar over the selected rows. Each action loops the existing
 * per-subshell endpoints, then invalidates the subshells query so the
 * live-fed list and home page reflect the change. Bulk Terminate was
 * removed with the human-facing action (spec 2026-09-03): Close covers it.
 */
export function SubshellManagerTable({ subshells }: { subshells: SubshellView[] }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  // Drop selections that vanished (e.g. deleted by a live frame mid-action).
  const selectedIds = selected.filter((id) => subshells.some((s) => s.id === id));

  const selectAllRef = useRef<HTMLInputElement>(null);
  const allSelected = subshells.length > 0 && selectedIds.length === subshells.length;
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedIds.length > 0 && !allSelected;
    }
  }, [selectedIds.length, allSelected]);

  const [lastBulkError, setLastBulkError] = useState<string | null>(null);

  async function runBulk(action: "restart" | "close") {
    const n = selectedIds.length;
    // Bulk close is destructive and asks; bulk restart does not (it spawns
    // subshells and resumes conversations — nothing is lost).
    const ok = action === "restart" ? true : await confirmCloseSubshells(n);
    if (!ok) return;
    setBulkBusy(true);
    setLastBulkError(null);
    try {
      // Loop the existing per-subshell endpoints for the selected rows.
      const perId =
        action === "close" ? (id: string) => `/api/subshells/${id}` : (id: string) => `/api/subshells/${id}/${action}`;
      const method = action === "close" ? ("DELETE" as const) : ("POST" as const);
      const results = await Promise.allSettled(selectedIds.map((id) => apiFetch(perId(id), { method })));
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed.length > 0) {
        setLastBulkError(
          `${failed.length} of ${results.length} ${action} call${failed.length === 1 ? "" : "s"} failed`,
        );
      }
      await queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
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
      {lastBulkError && <p className="text-destructive text-detail">{lastBulkError}</p>}
      {selectedIds.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="mr-2 text-muted-foreground text-sm">{selectedIds.length} selected</span>
          <Button variant="outline" size="sm" onClick={() => void runBulk("restart")} disabled={bulkBusy}>
            <RotateCcw /> Restart
          </Button>
          <Button variant="destructive" size="sm" onClick={() => void runBulk("close")} disabled={bulkBusy}>
            <X /> Close
          </Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-detail text-muted-foreground uppercase">
              <th className="w-9 px-3 py-2.5">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  aria-label="Select all subshells"
                  className="h-4 w-4 rounded border border-input bg-background accent-primary"
                  checked={allSelected}
                  onChange={(e) => setSelected(e.target.checked ? subshells.map((s) => s.id) : [])}
                />
              </th>
              <th className="px-3 py-2.5 text-left font-strong">Name</th>
              <th className="px-3 py-2.5 text-left font-strong">Status</th>
              <th className="px-3 py-2.5 text-left font-strong">Working dir</th>
              <th className="px-3 py-2.5 text-left font-strong">Last output</th>
              <th className="px-3 py-2.5 text-left font-strong">Uptime</th>
              <th className="px-3 py-2.5 text-left font-strong" title={AUTO_RESTART_HELP}>
                Auto-restart
              </th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {subshells.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                  No subshells yet.
                </td>
              </tr>
            ) : (
              subshells.map((s) => {
                // Same `=== true` posture as RowStatusBadges: with the node
                // down, lastOutputAt/startedAt/alive are last-known facts, so
                // the two time cells must not assert from them (spec §5.6) —
                // "—" is this table's existing nothing-to-say idiom.
                const offline = s.nodeOffline === true;
                return (
                  <tr key={s.id} className="border-b last:border-0 hover:bg-accent/40">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Select subshell ${s.name}`}
                        className="h-4 w-4 rounded border border-input bg-background accent-primary"
                        checked={selectedIds.includes(s.id)}
                        onChange={(e) => toggle(s.id, e.target.checked)}
                      />
                    </td>
                    <td className="max-w-[200px] truncate px-3 py-2">
                      <Link to="/subshells/$id" params={{ id: s.id }} className="hover:text-primary">
                        {s.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <RowStatusBadges subshell={s} />
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
                        <SubshellActionsMenu subshell={s} disabled={bulkBusy} />
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
