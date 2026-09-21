import type { JSX } from "react";
import { useState } from "react";
import { useSetNodeMaintenance } from "../hooks/use-node-detail";
import { errMessage } from "../lib/api";
import { confirmStartMaintenance } from "../lib/node-confirmations";
import { maintenanceRefusalNotice } from "../lib/node-maintenance";
import { relativeElapsed } from "../lib/relative-elapsed";
import type { NodeDetail } from "../types/node";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

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
 * It lives on the Overview, for everyone who manages the node, on every kind
 * of machine: one switch that appears in different places depending on the
 * kind of machine is a switch people stop finding. (It briefly lived under a
 * Configuration tab; that tab was deleted outright and its lone card
 * promoted to the Overview beside this one.)
 *
 * The description is two sentences, per the copy rule; the CLI equivalence
 * sits in the card's one-line detail slot, and AGENT-ONLY: `subshell
 * maintenance on|off` is the agent's own command, and the control-plane host
 * runs no agent to type it into, even though the FLAG means the same thing
 * on every machine (spec 2026-09-14: `local` included).
 *
 * Hidden — not disabled — for a viewer who cannot manage the node, the way its
 * predecessor was: the route refuses them, and `canManage` is the server's own
 * answer to that question rather than a client-side re-derivation of who is an
 * admin.
 */
/**
 * `onMaintenanceChanged` is the caller's fallout hook, and it exists because
 * the fallout is a property of the SURFACE, not of the node: on the control
 * plane a flip terminates subshells the viewer can see in their sidebar, so
 * the plane's route passes a callback that invalidates that list; the node's
 * own dashboard has no subshell query at all and passes nothing. The hook
 * invalidates the two node caches itself — those are the same on both
 * surfaces.
 */
export function NodeMaintenanceCard({
  node,
  onMaintenanceChanged,
}: {
  node: NodeDetail;
  onMaintenanceChanged?: () => void;
}): JSX.Element | null {
  const setMaintenance = useSetNodeMaintenance(node.id);
  const [error, setError] = useState<string | null>(null);
  // A flip the node only PARTLY applied is not an error and not a success, and
  // it has to be said here: the switch and the state line both move to "in
  // maintenance", so a window where three of five kills were refused otherwise
  // renders exactly like a clean one.
  const [refusals, setRefusals] = useState<string | null>(null);

  if (!node.canManage) return null;

  function toggle(checked: boolean): void {
    if (setMaintenance.isPending) return;
    setError(null);
    setRefusals(null);
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
        onSuccess: (result) => {
          setRefusals(maintenanceRefusalNotice(node.name, result.failed));
          onMaintenanceChanged?.();
        },
        onError: (err) => setError(errMessage(err, "Couldn't change this node's maintenance state.")),
      });
    })();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Maintenance</CardTitle>
        <CardDescription>
          Turning this on blocks new subshells on this machine for everyone, and stops whatever is running. They will
          not come back on their own when maintenance ends.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-4">
          <Switch
            checked={node.maintenance}
            onCheckedChange={toggle}
            disabled={setMaintenance.isPending}
            // Named, because a node's page carries several switches and a bare
            // "Maintenance mode" reads identically on all of them. The visible
            // words stay a substring of this, per the label-in-name rule.
            aria-label={`Maintenance mode on ${node.name}`}
          />
          {/* The label names WHICH SWITCH this is and never changes; it used
              to flip to "Accepting subshells" exactly when the switch was
              OFF, which reads as "accepting: off", the opposite of the
              truth. The state line below appears ONLY in maintenance: an
              off switch describing its own off-state ("Accepting new
              subshells") is a tautology, while how long it has been ON and
              who said so is a fact someone acts on. */}
          <Label>Maintenance mode</Label>
        </div>
        {node.maintenance && <p className="text-detail text-muted-foreground">{maintenanceSinceLabel(node)}</p>}
        {/* The CLI equivalence is a one-line detail, not a third sentence of
            explanation: the CardDescription stays within the two-sentence
            rule, and this joins the card's other detail lines. AGENT-ONLY:
            `subshell maintenance on|off` is the agent's own command, and the
            control-plane host runs no agent to type it into. */}
        {node.kind === "agent" && (
          <p className="text-detail text-muted-foreground">
            Same flag from this machine's command line: <code>subshell maintenance on|off</code>.
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive text-detail">
            {error}
          </p>
        )}
        {/* Amber rather than destructive: the switch did what it was asked, and
            calling it a failure would send the reader to retry a flip that has
            already landed. What is wrong is the machine, not the act. */}
        {refusals && (
          <p role="alert" className="text-amber-600 text-detail dark:text-amber-400">
            {refusals}
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
 * half is dropped when the server has no answer for it, so a row carrying no
 * stamp reads as a plain fact instead of "since null".
 */
function maintenanceSinceLabel(node: NodeDetail): string {
  const since = node.maintenanceAt === null ? "" : ` since ${relativeElapsed(node.maintenanceAt)}`;
  const source =
    node.maintenanceSource === null
      ? ""
      : ` · declared ${node.maintenanceSource === "node" ? "at the node" : "from this page"}`;
  return `In maintenance${since}${source}`;
}
