import type { JSX } from "react";
import { useState } from "react";
import { relativeElapsed } from "@/components/subshell-status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSetNodeMaintenance } from "@/hooks/use-nodes";
import { errMessage } from "@/lib/api";
import { confirmStartMaintenance } from "@/lib/node-confirmations";
import type { NodeDetail } from "@/types/node";

/**
 * Whether this machine takes new work (spec 2026-09-14 §6) — on the Overview
 * of EVERY node, the control-plane host included.
 *
 * It replaced `LocalLaunchCard`, which was not really a switch: ON was the
 * seeded Everyone/`edit` grant on the `local` row and OFF was its removal, so
 * the one launch control in the product was share surgery on one node, and it
 * could not generalise — an agent node's owner *is* the owner, and you cannot
 * unshare someone from their own machine. This writes a flag on the node
 * instead and never touches a grant. Shares still answer WHO may launch;
 * maintenance answers WHETHER ANYONE may, and the server ANDs the two into
 * `canLaunch`.
 *
 * It lives on the Overview rather than under Configuration because `local` has
 * no other section (`node-section-nav.tsx` hides all three for the host and
 * for a `view` grantee), and one switch that appears in different places
 * depending on the kind of machine is a switch people stop finding.
 *
 * Hidden — not disabled — for a viewer who cannot manage the node, the way its
 * predecessor was: the route refuses them, and `canManage` is the server's own
 * answer to that question rather than a client-side re-derivation of who is an
 * admin.
 */
export function NodeMaintenanceCard({ node }: { node: NodeDetail }): JSX.Element | null {
  const setMaintenance = useSetNodeMaintenance(node.id);
  const [error, setError] = useState<string | null>(null);

  if (!node.canManage) return null;

  function toggle(checked: boolean): void {
    if (setMaintenance.isPending) return;
    setError(null);
    void (async () => {
      // Only the ON direction asks. Ending maintenance widens what the machine
      // accepts and loses nothing; starting it stops every subshell here —
      // other people's included, since any share on a node lets the grantee
      // launch there and what they launched is invisible to this owner.
      if (
        checked &&
        !(await confirmStartMaintenance({
          name: node.name,
          isLocal: node.kind === "local",
          runningSubshells: node.runningSubshells,
        }))
      ) {
        return;
      }
      setMaintenance.mutate(checked, {
        onError: (err) => setError(errMessage(err, "Couldn't change this node's maintenance state.")),
      });
    })();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Maintenance</CardTitle>
        <CardDescription>
          While a node is in maintenance nobody can start a subshell on it — not its owner, not the people it is shared
          with, not admins. Everything else keeps working: service control, logs, agent detection and restart all answer
          as usual. Subshells stopped by turning this on stay in the list and can be restarted once maintenance ends;
          the ones set to restart by themselves will <strong>not</strong> come back on their own. Running{" "}
          <code>subshell maintenance on</code> or <code>off</code> at the machine does the same thing — it is one flag,
          settable from either end.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-4">
          <Switch
            checked={node.maintenance}
            onCheckedChange={toggle}
            disabled={setMaintenance.isPending}
            // Named, because a node's page carries several switches and a bare
            // "Maintenance" reads identically on all of them.
            aria-label={`Maintenance on ${node.name}`}
          />
          <Label>{node.maintenance ? maintenanceSinceLabel(node) : "Accepting subshells"}</Label>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The state line for a node in maintenance: how long, and which end said so.
 *
 * The source is worth a clause of its own rather than a detail somewhere: "at
 * the node" means somebody is standing at that machine with a reason, which is
 * exactly what a manager should know before undoing it from a browser. Either
 * half is dropped when the server has no answer for it, so a row that was
 * flipped before the stamps existed reads as a plain fact instead of "since
 * null".
 */
function maintenanceSinceLabel(node: NodeDetail): string {
  const since = node.maintenanceAt === null ? "" : ` since ${relativeElapsed(node.maintenanceAt)}`;
  const source =
    node.maintenanceSource === null
      ? ""
      : ` · declared ${node.maintenanceSource === "node" ? "at the node" : "from this page"}`;
  return `In maintenance${since}${source}`;
}
