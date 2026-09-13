import type { JSX } from "react";
import { Fact, FactCard } from "@/components/admin-status/fact-list";
import { CopyableValue } from "@/components/service/copyable-value";
import { Badge } from "@/components/ui/badge";
import type { NodeDetail, NodeRuntime } from "@/types/node";

/** Who is running the agent, and since when. */
export function supervisionLine(runtime: NodeRuntime): string {
  if (!runtime.supervised) return "Not supervised";
  const manager = runtime.service.manager ?? "a service manager";
  const pid = runtime.service.pid === null ? "" : ` (pid ${runtime.service.pid})`;
  return `${manager}${pid}${runtime.service.enabled ? " · starts at login" : ""}`;
}

/**
 * The part "starts at login" does not say, on systemd.
 *
 * A `--user` unit runs inside the owner's login session, so it comes up at
 * login and goes down at LOGOUT — which on a headless box that nobody logs
 * into is the difference between an agent that is there and one that is not.
 * `loginctl enable-linger` is what decouples the two, and the agent's own
 * install prints that advice... to a terminal, on a machine most people never
 * open a terminal on. This card is the only surface a headless node's owner
 * sees, so the caveat belongs here too.
 *
 * launchd has no equivalent knob and needs no note: a LaunchAgent's lifetime
 * is the GUI session by design, and a machine with no one logged in is not
 * running one either way.
 */
export function lingerNote(runtime: NodeRuntime): string | null {
  if (!runtime.supervised || runtime.service.enabled !== true) return null;
  if (runtime.service.manager !== "systemd") return null;
  return "Starting at login is not the same as staying up after logout: a systemd user service stops when its owner logs out. `loginctl enable-linger` on that machine keeps it running.";
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
  const linger = lingerNote(runtime);

  return (
    <FactCard title="Runtime">
      <Fact label="Up since">{new Date(runtime.startedAt).toLocaleString()}</Fact>
      <Fact label="Supervised by">
        {supervisionLine(runtime)}
        {linger && <span className="mt-1 block text-muted-foreground text-xs">{linger}</span>}
      </Fact>
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
