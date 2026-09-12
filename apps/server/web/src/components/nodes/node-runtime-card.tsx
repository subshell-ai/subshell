import { RotateCw, X } from "lucide-react";
import type { JSX } from "react";
import { Fact, FactCard } from "@/components/admin-status/fact-list";
import { CopyableValue } from "@/components/service/copyable-value";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useNodeRestartWait } from "@/hooks/use-node-restart-wait";
import { useRestartNode } from "@/hooks/use-nodes";
import { errMessage } from "@/lib/api";
import { confirmAction } from "@/lib/confirm";
import type { NodeDetail, NodeRuntime } from "@/types/node";

/** Who is running the agent, and since when. */
function supervisionLine(runtime: NodeRuntime): string {
  if (!runtime.supervised) return "Not supervised";
  const manager = runtime.service.manager ?? "a service manager";
  const pid = runtime.service.pid === null ? "" : ` (pid ${runtime.service.pid})`;
  return `${manager}${pid}${runtime.service.enabled ? " · starts at login" : ""}`;
}

/** What the wait is saying right now, or null while nothing has been asked for. */
function WaitLine({ name, wait }: { name: string; wait: ReturnType<typeof useNodeRestartWait> }): JSX.Element | null {
  if (wait.outcome === "waiting") {
    return <p className="col-span-full text-sm text-warning">Restarting… waiting for {name} to come back.</p>;
  }
  if (wait.outcome === "back") {
    return (
      <p className="col-span-full flex items-center gap-2 text-sm text-success">
        Back.
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => wait.reset()}>
          <X />
        </Button>
      </p>
    );
  }
  if (wait.outcome === "timeout") {
    return (
      <p className="col-span-full text-destructive text-sm">
        The node has not come back. Check the agent on that machine.
      </p>
    );
  }
  return null;
}

/**
 * How one node's agent is running, and the one control that acts on the
 * process (spec 2026-09-12 § 6.2 and § 6.3).
 *
 * This card is the ONLY surface that answers these questions for a headless
 * node. A Linux box nobody ever opens a window on reports everything the
 * client app's status card shows locally — supervision, uptime, where its
 * config and log live, whether tmux was found — and it reaches its owner here,
 * from any browser.
 *
 * It renders nothing without a report, which is also the whole access rule:
 * the server attaches `runtime` only for an online agent node whose viewer can
 * configure it, so there is no gate to re-derive on this side.
 */
export function NodeRuntimeCard({ node }: { node: NodeDetail }): JSX.Element | null {
  const runtime = node.runtime;
  const restart = useRestartNode(node.id);
  const wait = useNodeRestartWait(node.id);

  if (!runtime) return null;

  const kills = runtime.service.paneSafety !== "keeps";

  async function requestRestart(): Promise<void> {
    if (!runtime) return;
    const ok = await confirmAction({
      title: `Restart the agent on "${node.name}"?`,
      description: kills
        ? `This node's service definition will close every subshell running there. Reinstall the service definition on ${node.name} to fix this, or restart anyway.`
        : "Subshells running there keep running; the node is offline for a few seconds.",
      confirmLabel: kills ? "Restart anyway" : "Restart agent",
      danger: true,
    });
    if (!ok) return;
    try {
      await restart.mutateAsync(kills ? { force: true } : {});
      // Captured here, not read during the wait: the report goes away with
      // the socket the moment the agent drops.
      wait.begin(runtime.startedAt);
    } catch {
      // The mutation keeps the failure; it renders under the button.
    }
  }

  return (
    <FactCard title="Runtime">
      <Fact label="Up since">{new Date(runtime.startedAt).toLocaleString()}</Fact>
      <Fact label="Supervised by">{supervisionLine(runtime)}</Fact>
      <Fact label="tmux">
        {runtime.tmuxPath ? (
          <span className="break-all font-mono text-xs">{runtime.tmuxPath}</span>
        ) : (
          // Said here rather than discovered at launch time: without tmux the
          // agent accepts nothing, and nothing else on this page would say so.
          <Badge variant="warning">not found: this node accepts no launches</Badge>
        )}
      </Fact>
      <Fact label="Agent binary" mono wide>
        <CopyableValue value={runtime.binaryPath} label="Agent binary" />
      </Fact>
      <Fact label="Config file" mono wide>
        <CopyableValue value={runtime.configPath} label="Config file" />
      </Fact>
      <Fact label="Log" mono wide>
        {(runtime.logPath ?? runtime.logHint) ? (
          <CopyableValue value={(runtime.logPath ?? runtime.logHint) as string} label="Log" />
        ) : (
          "—"
        )}
      </Fact>
      {runtime.service.definitionPath && (
        <Fact label="Service definition" mono wide>
          <CopyableValue value={runtime.service.definitionPath} label="Service definition" />
        </Fact>
      )}

      {!runtime.supervised && (
        <p className="col-span-full text-muted-foreground text-sm">
          Nothing on that machine is supervising this agent, so exiting would stop it rather than restart it. Restart it
          where it was started.
        </p>
      )}
      {kills && runtime.supervised && (
        <p className="col-span-full text-sm text-warning">
          Restarting will close every subshell running there; reinstall the service definition on that machine to fix
          this.
        </p>
      )}

      <div className="col-span-full flex items-center gap-3">
        <Button
          variant="outline"
          disabled={!runtime.supervised || wait.waiting || restart.isPending}
          title={
            runtime.supervised
              ? undefined
              : "This agent is not supervised, so exiting would stop it rather than restart it"
          }
          onClick={() => void requestRestart()}
        >
          <RotateCw /> Restart agent
        </Button>
      </div>

      <WaitLine name={node.name} wait={wait} />
      {restart.error && (
        <p className="col-span-full text-destructive text-sm">
          {errMessage(restart.error, "The agent could not be restarted.")}
        </p>
      )}
    </FactCard>
  );
}
