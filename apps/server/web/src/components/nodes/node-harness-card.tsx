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

/** What a row of {@link NodeHarnessCard} knows about one program on this machine. */
interface DetectionRow {
  /** The node's answer: the program was found here */
  installed: boolean;
  /** Why the lookup failed, when it ran and failed. Absent when it never ran. */
  reason?: string;
  /** When the probe ran. Absent when no probe has covered this plugin yet. */
  checkedAt?: string;
}

/**
 * The row's one-word detection verdict — and one of the four is "we do not
 * know", which is NOT the same claim as "not found".
 *
 * A row carries no `reason` only when nothing looked: either no detection has
 * covered this plugin on this node at all (no `checkedAt` either — a node
 * enrolled but never probed, or one offline since the plugin was installed),
 * or a probe ran and threw, which `scanOne` records deliberately without a
 * reason because "the probe failed" is different from "we looked and it was
 * not there". Every real miss travels with a reason (`binary-lookup.ts` gives
 * one on every `path: null` path), so reading its absence as a missing program
 * asserted a negative nothing had established — the card said "program not
 * found" about a machine that may well have the CLI.
 */
function badgeLabel(h: DetectionRow): string {
  if (h.installed || h.reason === "no-binary") return "ready";
  if (h.reason) return "program not found";
  return h.checkedAt ? "check failed" : "not checked";
}

/** The tone that verdict carries: found, definitely missing, or unknown. */
function badgeVariant(h: DetectionRow): "success" | "muted" | "outline" {
  if (h.installed || h.reason === "no-binary") return "success";
  return h.reason ? "muted" : "outline";
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
              <p className="text-detail text-success">Re-check sent. Inventory will refresh shortly.</p>
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

        {/* A headerless table: ONE grid for every row, so the four columns
            share their tracks and line up down the card. Each row was its own
            flex before, where the name took the slack and pushed the rest
            right — which put every row's badge at a different place, since the
            version strings are different widths. `auto` tracks size to the
            widest cell, which is the alignment a table gives and a row of
            flex items cannot.

            Rows are `display: contents` (see the fragment's inner wrapper):
            the row element itself draws nothing, so its cells are the grid's
            own children. That is also why every cell is ALWAYS rendered, even
            empty — a skipped cell would slide the rest of that row one column
            left.

            Two columns below `sm`, four above: version and checked-at fall to
            a second line on a phone rather than crushing the name. */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
          {harnesses.map((h) => (
            <div key={h.harnessId} className="contents">
              {/* Named by the node view itself: every row carries the display
                  name from the instance store's manifest (spec 2026-09-10
                  follow-ups), so the page needs no second registry read and a
                  registry-installed plugin is named exactly like a built-in. */}
              <div className="flex min-w-0 items-center gap-3">
                <PluginIcon pluginId={h.harnessId} name={h.name} />
                <span className="truncate font-strong">{h.name}</span>
              </div>
              {/* The badge is the detection answer: whether the program this
                  plugin drives was found on this machine. `no-binary` reads
                  ready because a plugin that declares no program is not one
                  whose program is missing. */}
              <Badge variant={badgeVariant(h)} className="justify-self-start">
                {badgeLabel(h)}
              </Badge>
              <span className="font-mono text-detail text-muted-foreground">{h.version ?? ""}</span>
              <span className="text-detail text-muted-foreground">{checkedAtLabel(h.checkedAt) ?? ""}</span>
              {h.reason === "override-invalid" && (
                <p className="col-span-full text-detail text-muted-foreground">
                  An environment variable overrides where this program is looked for, and it doesn't point at an
                  executable file on this node.
                </p>
              )}
              {h.reason === "no-binary" && (
                <p className="col-span-full text-detail text-muted-foreground">No separate program is needed here.</p>
              )}
              {/* The unknown states, spelled out: neither says anything about
                  whether the program is here, because nothing established it. */}
              {!h.installed && !h.reason && h.checkedAt === undefined && (
                <p className="col-span-full text-detail text-muted-foreground">
                  No detection has covered this plugin here yet. Opening this page asks for one; an offline node cannot
                  answer.
                </p>
              )}
              {!h.installed && !h.reason && h.checkedAt !== undefined && (
                <p className="col-span-full text-detail text-muted-foreground">
                  The probe did not complete, so whether this program is here is unknown.
                </p>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
