import type { NodeServiceVerb } from "@internal/subshell-protocol";
import { LoaderCircle } from "lucide-react";
import type { JSX } from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useNodeRestartWait } from "@/hooks/use-node-restart-wait";
import { useNodeService } from "@/hooks/use-nodes";
import { errMessage } from "@/lib/api";
import { confirmAction } from "@/lib/confirm";
import type { NodeDetail } from "@/types/node";

/** One button: what it does, and what a person needs to know before pressing it. */
interface VerbSpec {
  verb: NodeServiceVerb;
  label: string;
  /** The confirmation's body. `kills` is whether this node's definition ends panes. */
  describe: (nodeName: string, kills: boolean) => string;
  /** Owner-only, because it cannot be undone from here. */
  oneWay?: boolean;
  /** Can end live panes, so it carries `force`. */
  destructive?: boolean;
}

/**
 * The five verbs, in the order a person reads them: the one they want most
 * often first, the two that cannot be undone from here last.
 */
const VERBS: VerbSpec[] = [
  {
    verb: "restart",
    label: "Restart",
    destructive: true,
    describe: (name, kills) =>
      kills
        ? `This node's service definition will close every subshell running on ${name}. Reinstall the definition on that machine to fix this, or restart anyway.`
        : "Subshells running there keep running; the node is offline for a few seconds.",
  },
  {
    verb: "start",
    label: "Start",
    describe: (name) => `Asks ${name}'s service manager to start the agent from its installed definition.`,
  },
  {
    verb: "install",
    label: "Install service",
    describe: (name) =>
      `Writes a service definition on ${name} and enables it, so the agent comes back on its own instead of only when someone runs it.`,
  },
  {
    verb: "stop",
    label: "Stop",
    oneWay: true,
    destructive: true,
    describe: (name, kills) =>
      `${kills ? `This will close every subshell running on ${name}. ` : ""}Nothing here can start it again — that needs a shell on that machine.`,
  },
  {
    verb: "uninstall",
    label: "Uninstall service",
    oneWay: true,
    destructive: true,
    describe: (name, kills) =>
      `${kills ? `This will close every subshell running on ${name}. ` : ""}Removes the service definition, so the agent will not come back after a reboot. Nothing here can reinstall it once the agent is gone — that needs a shell on that machine.`,
  },
];

/**
 * The controls that act on a node's agent process (spec 2026-09-12, node half).
 *
 * **`stop` and `uninstall` say what they cost, in the confirmation.** A command
 * reaches a node over the AGENT'S OWN socket, so nothing in this app can start
 * an agent that is not running: those two end the connection that would have
 * carried the verb undoing them. The server gates them on ownership; this
 * names the consequence, because it is invisible from a button that looks like
 * every other one.
 *
 * The card renders nothing without a runtime report, which is also its access
 * rule — the server attaches one only for an online agent node whose viewer can
 * configure it, so there is no gate to re-derive here.
 */
export function NodeServiceCard({ node }: { node: NodeDetail }): JSX.Element | null {
  const runtime = node.runtime;
  const service = useNodeService(node.id);
  const wait = useNodeRestartWait(node.id);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!runtime) return null;

  const kills = runtime.service.paneSafety !== "keeps";
  const isOwner = node.access === "owner";

  async function run(spec: VerbSpec): Promise<void> {
    if (!runtime) return;
    setFailure(null);
    setDone(null);
    const ok = await confirmAction({
      title: `${spec.label} the agent on "${node.name}"?`,
      description: spec.describe(node.name, kills),
      confirmLabel: spec.destructive && kills ? `${spec.label} anyway` : spec.label,
      danger: spec.destructive === true,
    });
    if (!ok) return;
    try {
      // `force` only where it means something: the server refuses it on the
      // verbs that cannot close a subshell.
      const body = spec.destructive && kills ? { verb: spec.verb, force: true } : { verb: spec.verb };
      const res = await service.mutateAsync(body);
      // Captured here, not read during the wait: the report goes away with the
      // socket the moment the agent drops.
      if (spec.verb === "restart") wait.begin(runtime.startedAt);
      setDone(res.detail ?? `${spec.label} accepted.`);
    } catch (err) {
      setFailure(errMessage(err, `Could not ${spec.label.toLowerCase()} the agent`));
    }
  }

  /** Why this button cannot be pressed, or undefined when it can. */
  function blocked(spec: VerbSpec): string | undefined {
    if (spec.verb === "restart" && !runtime?.supervised) {
      return "Nothing on that machine is supervising this agent, so exiting would stop it rather than restart it";
    }
    if (spec.oneWay && !isOwner) return "Only the node's owner can do this — it cannot be undone from here";
    return undefined;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Service</CardTitle>
        <CardDescription>
          Drive the service manager on that machine. Stopping or uninstalling is one-way from here: nothing in this app
          can start an agent that is not running, because every command travels over the agent's own connection.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {VERBS.map((spec) => {
            const why = blocked(spec);
            return (
              <Button
                key={spec.verb}
                variant="outline"
                disabled={why !== undefined || service.isPending || wait.waiting}
                title={why}
                onClick={() => void run(spec)}
              >
                {spec.label}
              </Button>
            );
          })}
        </div>
        {wait.outcome === "waiting" && (
          <p className="flex items-center gap-2 text-sm text-warning">
            {/* The agent drops its socket and comes back; that is tens of
                seconds during which the card would otherwise sit still and
                read as a page that had ignored the press. */}
            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
            <span>Restarting… waiting for {node.name} to come back.</span>
          </p>
        )}
        {wait.outcome === "timeout" && (
          <p className="text-destructive text-sm">The node has not come back. Check the agent on that machine.</p>
        )}
        {done && <p className="whitespace-pre-wrap text-muted-foreground text-sm">{done}</p>}
        {failure && (
          <p role="alert" className="text-destructive text-sm">
            {failure}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
