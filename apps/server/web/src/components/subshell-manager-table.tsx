import { apiFetch, Button, Card, CardContent, CardHeader, CardTitle, relativeElapsed } from "@internal/node-admin";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { SubshellActionsMenu } from "@/components/subshell-actions-menu";
import { SubshellDot } from "@/components/subshell-dot";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import { confirmCloseSubshells, confirmRestartSubshells } from "@/lib/subshell-confirmations";
import type { SubshellSection } from "@/lib/subshell-sections";
import type { SubshellView } from "@/types/subshell";

/**
 * Full subshell table with per-row actions (restart / close — the ⋯ menu) and
 * a bulk-actions bar over the selected rows. Each action loops the existing
 * per-subshell endpoints, then invalidates the subshells query so the
 * live-fed list and home page reflect the change. Bulk Terminate was
 * removed with the human-facing action (spec 2026-09-03): Close covers it.
 *
 * `sections` draws a card per section (operator ask, 2026-09-24 —
 * the tiles were segmented and the list was not): the caller passes the SAME
 * `SubshellSection`s the tile view renders, so one grouping answers "which
 * machine" or "which state" identically in both views. Omitted, the table
 * stays the flat list it has always been.
 */
export function SubshellManagerTable({
  subshells,
  sections,
}: {
  subshells: SubshellView[];
  sections?: SubshellSection[];
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  // Drop selections that vanished (e.g. deleted by a live frame mid-action).
  const selectedIds = selected.filter((id) => subshells.some((s) => s.id === id));

  const [lastBulkError, setLastBulkError] = useState<string | null>(null);

  async function runBulk(action: "restart" | "close") {
    const n = selectedIds.length;
    // Bulk close is destructive and always asks. Bulk restart asks when the
    // selection contains LIVE panes (ruling 2026-10-02): restarting a live
    // pane stops its running process, and the per-row menu asks for exactly
    // that, so the bulk bar must not be looser than the row it mirrors. An
    // all-dead selection revives in place and loses nothing, so it asks
    // nothing, as restart always has on dead rows.
    const live =
      action === "restart" ? selectedIds.filter((id) => subshells.some((s) => s.id === id && s.alive)).length : 0;
    const ok =
      action === "restart" ? live === 0 || (await confirmRestartSubshells(n, live)) : await confirmCloseSubshells(n);
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
    <div className="flex flex-col gap-4">
      {lastBulkError && <p className="text-destructive text-detail">{lastBulkError}</p>}
      {selectedIds.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="mr-2 text-muted-foreground text-sm">{selectedIds.length} selected</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void runBulk("restart")}
            disabled={bulkBusy}
            disabledReason={"Wait for the current action on the selected subshells to finish."}
          >
            <RotateCcw /> Restart
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void runBulk("close")}
            disabled={bulkBusy}
            disabledReason={"Wait for the current action on the selected subshells to finish."}
          >
            <X /> Close
          </Button>
        </div>
      )}

      {(sections ?? [{ key: "*", label: "Subshells", title: "Subshells", subshells }]).map((sec) => {
        const groupIds = sec.subshells.map((s) => s.id);
        const groupSelected = groupIds.filter((id) => selectedIds.includes(id)).length;
        return (
          <Card key={sec.key} className="min-w-0">
            <CardHeader>
              <CardTitle className="min-w-0">
                {sec.label === sec.title ? (
                  <span className="block truncate">{sec.label}</span>
                ) : (
                  <TooltipProvider delay={300}>
                    <Tooltip>
                      <TooltipTrigger render={<span className="block truncate">{sec.label}</span>} />
                      <TooltipContent>{sec.title}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="@container overflow-x-auto">
                <table className="w-full text-sm" aria-label={sec.label}>
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="w-8 pr-4 pb-2 align-middle">
                        <input
                          ref={(input) => {
                            if (input) input.indeterminate = groupSelected > 0 && groupSelected < groupIds.length;
                          }}
                          type="checkbox"
                          aria-label={sections ? `Select all subshells in ${sec.label}` : "Select all subshells"}
                          className="block size-4 rounded border border-input bg-background accent-primary"
                          checked={groupIds.length > 0 && groupSelected === groupIds.length}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setSelected((previous) =>
                              checked
                                ? [...new Set([...previous, ...groupIds])]
                                : previous.filter((id) => !groupIds.includes(id)),
                            );
                          }}
                        />
                      </th>
                      <th className="pr-4 pb-2 font-strong">Name</th>
                      <th className="@lg:table-cell hidden whitespace-nowrap pr-4 pb-2 font-strong">Working dir</th>
                      <th className="@sm:table-cell hidden whitespace-nowrap pr-4 pb-2 font-strong">Last output</th>
                      <th className="@2xl:table-cell hidden whitespace-nowrap pr-4 pb-2 font-strong">Uptime</th>
                      <th className="w-px pb-2" aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {sec.subshells.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-muted-foreground">
                          No subshells yet.
                        </td>
                      </tr>
                    ) : (
                      sec.subshells.map(renderRow)
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );

  function renderRow(s: SubshellView) {
    // Same `=== true` posture as the dot's own indicator: with the
    // node down, lastOutputAt/startedAt/alive are last-known facts,
    // so the two time cells must not assert from them (spec §5.6) —
    // "—" is this table's existing nothing-to-say idiom.
    const offline = s.nodeOffline === true;
    const lastOutput = !offline && s.lastOutputAt ? relativeElapsed(s.lastOutputAt) : null;
    return (
      <tr key={s.id} className="border-b last:border-0">
        <td className="h-8 w-8 py-0 pr-4 align-middle">
          <input
            type="checkbox"
            aria-label={`Select subshell ${s.name}`}
            className="block size-4 rounded border border-input bg-background accent-primary"
            checked={selectedIds.includes(s.id)}
            onChange={(e) => toggle(s.id, e.target.checked)}
          />
        </td>
        <td className="h-8 @sm:w-1/3 w-full max-w-0 py-0 pr-4">
          <div className="flex min-w-0 items-center gap-2">
            <SubshellDot subshell={s} accessible className="mt-0" />
            <Link
              to="/subshells/$id"
              params={{ id: s.id }}
              className="truncate font-strong hover:underline"
              title={s.name}
            >
              {s.name}
            </Link>
          </div>
        </td>
        <td className="@lg:table-cell hidden h-8 max-w-0 truncate py-0 pr-4 text-muted-foreground">{s.workingDir}</td>
        <td className="@sm:table-cell hidden h-8 whitespace-nowrap py-0 pr-4 text-muted-foreground">
          {lastOutput === null ? "—" : lastOutput === "just now" ? lastOutput : `${lastOutput} ago`}
        </td>
        <td className="@2xl:table-cell hidden h-8 whitespace-nowrap py-0 pr-4 text-muted-foreground">
          {!offline && s.status === "running" && s.alive && s.startedAt ? relativeElapsed(s.startedAt) : "—"}
        </td>
        <td className="h-8 w-px py-0 text-right">
          <div className="flex justify-end">
            <SubshellActionsMenu subshell={s} disabled={bulkBusy} />
          </div>
        </td>
      </tr>
    );
  }
}
