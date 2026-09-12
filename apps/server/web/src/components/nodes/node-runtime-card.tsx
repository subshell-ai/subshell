import type { JSX } from "react";
import { Fact, FactCard } from "@/components/admin-status/fact-list";
import { CopyableValue } from "@/components/service/copyable-value";
import { Badge } from "@/components/ui/badge";
import type { NodeDetail, NodeRuntime } from "@/types/node";

/** Who is running the agent, and since when. */
function supervisionLine(runtime: NodeRuntime): string {
  if (!runtime.supervised) return "Not supervised";
  const manager = runtime.service.manager ?? "a service manager";
  const pid = runtime.service.pid === null ? "" : ` (pid ${runtime.service.pid})`;
  return `${manager}${pid}${runtime.service.enabled ? " · starts at login" : ""}`;
}

/**
 * How one node's agent is running (spec 2026-09-12 § 6.2).
 *
 * FACTS ONLY. The verbs that act on that process live in `NodeServiceCard`
 * beside it (spec 2026-09-12, node half): two cards on one page each offering
 * Restart would raise the question of whether they differ.
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

  if (!runtime) return null;

  const kills = runtime.service.paneSafety !== "keeps";

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
          This node's service definition would close every subshell running there when the agent stops or restarts;
          reinstall the definition on that machine to fix this.
        </p>
      )}
    </FactCard>
  );
}
