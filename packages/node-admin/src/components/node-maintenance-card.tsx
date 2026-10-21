import type { JSX } from "react";
import { useState } from "react";
import { useSetNodeMaintenance } from "../hooks/use-node-detail";
import { errMessage } from "../lib/api";
import { confirmAction } from "../lib/confirm";
import { confirmStartMaintenance } from "../lib/node-confirmations";
import { maintenanceRefusalNotice } from "../lib/node-maintenance";
import { relativeElapsed } from "../lib/relative-elapsed";
import type { NodeDetail } from "../types/node";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { HelperCaption } from "../ui/helper-caption";

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
      const confirmed = checked
        ? await confirmStartMaintenance({
            name: node.name,
            isLocal: node.kind === "local",
            runningSubshells: node.runningSubshells,
          })
        : await confirmAction({
            title: "End maintenance?",
            description: `Allow new subshells on "${node.name}" again. Stopped subshells won't restart automatically.`,
            confirmLabel: "End maintenance",
          });
      if (!confirmed) return;
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
          Maintenance blocks new subshells on this machine for everyone and tries to stop existing ones. Some may keep
          running if they can't be stopped. Subshells that stop won't restart automatically when maintenance ends.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-3">
        <Button
          variant="outline"
          onClick={() => toggle(!node.maintenance)}
          disabled={setMaintenance.isPending}
          disabledReason="The maintenance change is still in progress."
        >
          {node.maintenance ? "End maintenance" : "Start maintenance"}
        </Button>
        {node.maintenance && <p className="text-detail text-muted-foreground">{maintenanceSinceLabel(node)}</p>}
        {/* The CLI equivalence is a one-line detail, not a third sentence of
            explanation: the CardDescription stays within the two-sentence
            rule, and this joins the card's other detail lines. AGENT-ONLY:
            `subshell maintenance on|off` is the agent's own command, and the
            control-plane host runs no agent to type it into. */}
        {node.kind === "agent" && (
          <HelperCaption>
            Same flag from this machine's command line: <code>subshell maintenance on|off</code>.
          </HelperCaption>
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
          <p role="alert" className="text-detail text-warning">
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
