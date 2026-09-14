import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { PluginIcon } from "@/components/plugin-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useNodeHarnesses } from "@/hooks/use-harnesses";
import { useRecheckNode } from "@/hooks/use-nodes";
import { errMessage } from "@/lib/api";
import { checkedAtLabel } from "@/lib/checked-at";

/** The row's one-word detection verdict: the program runs here, or it was not found. */
function badgeLabel(h: { installed: boolean; reason?: string }): string {
  return h.installed || h.reason === "no-binary" ? "ready" : "program not found";
}

/** The tone that verdict carries. */
function badgeVariant(h: { installed: boolean; reason?: string }): "success" | "muted" {
  return h.installed || h.reason === "no-binary" ? "success" : "muted";
}

/**
 * Which harnesses this machine can RUN (spec 2026-09-10): detection output,
 * not a plugin manager. The rows are the node view's — one per plugin the
 * INSTANCE has installed and enabled, crossed with this machine's binary
 * answer (server-side `inventory.ts → effectiveHarnessStates`): a live probe
 * for `local`, the cached detection for an enrolled node. A row whose plugin
 * the instance dropped never arrives, and this card adds rows from nothing
 * else — the old catalog lookup that listed uninstalled plugins as install
 * extras is gone with the per-node plugin route (Task 9).
 *
 * Two former branches are gone because they stopped being facts about THIS
 * machine: `broken` and `restartRequired` describe plugin loading in the
 * control-plane process, and the instance plugins page says so. Rendering
 * them here would attribute an instance failure to one node.
 *
 * The only control is Re-check, gated by the SAME rule the server's recheck
 * route applies — `nodeCanConfigure` (owner or `edit`;
 * `api/src/lib/node-access.ts`, and the security posture states it plainly:
 * "edit (or owner) additionally configures the node (re-checks)"). It is
 * deliberately NOT `canManage`: on an agent that flag is owner-or-admin-on-
 * local, narrower than what the route honours, and hiding a permitted action
 * is a capability regression. `access` is server-derived on the view (admins
 * resolve to `edit` there), so this mirrors the gate without re-deriving
 * admin identity client-side. `local` is excluded outright — its view probes
 * live on every read, and the recheck route answers it 400.
 */
export function NodeHarnessCard({ nodeId }: { nodeId: string }) {
  const { harnesses, data, isLoading } = useNodeHarnesses(nodeId);
  const recheck = useRecheckNode(nodeId);

  if (isLoading) return <p className="text-muted-foreground text-sm">Loading…</p>;

  // The web-side mirror of `nodeCanConfigure` — the SPA hand-mirrors the
  // server's view model and its rules (see `types/node.ts`), and no helper
  // for this one existed here. `access` is "none" nowhere a view exists, so
  // owner|edit is exactly the route's gate.
  const canRecheck = data !== undefined && data.kind === "agent" && (data.access === "owner" || data.access === "edit");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Harnesses</CardTitle>
        <CardDescription>
          Which agents this machine can run: one row per plugin the instance has installed, matched against what
          detection found here. Plugins themselves are managed under{" "}
          <Link to="/settings/plugins" className="underline">
            Settings → Plugins
          </Link>
          , not per node.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {canRecheck && (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={recheck.isPending}
              onClick={() => recheck.mutate()}
            >
              <RefreshCw /> {recheck.isPending ? "Re-checking…" : "Re-check"}
            </Button>
            {recheck.isSuccess && (
              <p className="text-success text-xs">Re-check sent. Inventory will refresh shortly.</p>
            )}
          </div>
        )}
        {recheck.isError && (
          <p role="alert" className="text-destructive text-sm">
            {errMessage(recheck.error, "Re-check failed. The node may be offline.")}
          </p>
        )}

        {data?.inventoryStale && (
          <p className="text-muted-foreground text-sm">
            The inventory may be outdated. These states are last-known, not live; a re-check refreshes them.
          </p>
        )}

        {harnesses.length === 0 && (
          <p className="text-muted-foreground text-sm">
            Nothing to report: either no plugins are installed on the instance, or this node hasn't been detected yet.
          </p>
        )}

        {harnesses.map((h) => (
          <div key={h.harnessId} className="space-y-1">
            <div className="flex flex-wrap items-center gap-3">
              {/* Named by the node view itself: every row carries the display
                  name from the instance store's manifest (spec 2026-09-10
                  follow-ups), so the page needs no second registry read and a
                  registry-installed plugin is named exactly like a built-in. */}
              <PluginIcon pluginId={h.harnessId} name={h.name} />
              <span className="min-w-0 flex-1 truncate font-strong">{h.name}</span>
              {/* The badge is the detection answer: whether the program this
                  plugin drives was found on this machine. `no-binary` reads
                  ready because a plugin that declares no program is not one
                  whose program is missing. */}
              <Badge variant={badgeVariant(h)}>{badgeLabel(h)}</Badge>
              {h.version && <span className="font-mono text-muted-foreground text-xs">{h.version}</span>}
              {checkedAtLabel(h.checkedAt) && (
                <span className="text-muted-foreground text-xs">{checkedAtLabel(h.checkedAt)}</span>
              )}
            </div>
            {h.reason === "override-invalid" && (
              <p className="text-muted-foreground text-xs">
                An environment variable overrides where this program is looked for, and it doesn't point at an
                executable file on this node.
              </p>
            )}
            {h.reason === "no-binary" && (
              <p className="text-muted-foreground text-xs">No separate program is needed here.</p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
