import type { JSX } from "react";
import { Fact, FactCard } from "@/components/admin-status/fact-list";
import { Badge } from "@/components/ui/badge";
import { CopyableValue } from "@/components/ui/copyable-value";
import { LINGER_COMMAND, type PersistenceFix, persistence } from "@/lib/supervision";
import type { NodeDetail, NodeRuntime } from "@/types/node";

/**
 * Who is running the agent, and since when.
 *
 * No "starts at login" tail: whether this machine brings the agent back is its
 * own fact now, stated in full one row down. Carrying both put a hint on this
 * line about what the other line answers — and the hint was the half that was
 * wrong on Linux.
 */
export function supervisionLine(runtime: NodeRuntime): string {
  if (!runtime.supervised) return "Not supervised";
  const manager = runtime.service.manager ?? "a service manager";
  const pid = runtime.service.pid === null ? "" : ` (pid ${runtime.service.pid})`;
  return `${manager}${pid}`;
}

/**
 * What to do about a machine that will not bring the agent back.
 *
 * Two shapes, because the two remedies live in different places. Lingering is
 * a command in a shell ON that machine, so it is offered copyably; installing
 * or arming a definition has no node route at all, and the honest thing is to
 * point at the button one card down rather than to imply this page could do it.
 */
function FixLine({ fix }: { fix: PersistenceFix }): JSX.Element {
  // A `switch` with an exhaustive default rather than an `if` and a
  // fall-through: the install sentence is right for the two remedies that
  // exist beside lingering today, and silently wrong for a third one added
  // later. This way a new `PersistenceFix` kind fails the build here.
  switch (fix.kind) {
    case "linger":
      return (
        <span className="mt-1 block text-detail text-muted-foreground">
          {fix.measured
            ? "To keep it running after you log out:"
            : // logind never answered — a container, or no loginctl on PATH — so
              // this is a condition on the remedy rather than a fault to report.
              // The sentence above already asked the question; restating it here
              // would be the card saying the same thing twice.
              "If it needs to stay up with nobody logged in:"}{" "}
          <CopyableValue value={LINGER_COMMAND} label="Linger command" />
        </span>
      );
    case "install":
    case "enable":
      return (
        <span className="mt-1 block text-detail text-muted-foreground">
          Install service below writes a definition and enables it.
        </span>
      );
    default: {
      const unhandled: never = fix;
      return <>{String(unhandled)}</>;
    }
  }
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
 * **"Comes back" is measured, not advised.** The agent reports `linger`, so
 * this card says which of the two a systemd machine IS rather than explaining
 * both and leaving the reader to work out which one is theirs. The sentences
 * come from `lib/supervision.ts`, shared with the server's own Service page, so
 * the two surfaces answer one question — will this still be running after a
 * reboot, or after I log out? — in one voice. launchd carries no such fact and
 * none is missing: a LaunchAgent's lifetime IS the login session by design,
 * there is no knob, and a Mac nobody logs in to runs no agents either way.
 *
 * It renders nothing without a report, which is also the whole access rule:
 * the server attaches `runtime` only for an online agent node whose viewer can
 * configure it, so there is no gate to re-derive on this side.
 */
export function NodeRuntimeCard({ node }: { node: NodeDetail }): JSX.Element | null {
  const runtime = node.runtime;

  if (!runtime) return null;

  const kills = runtime.service.paneSafety !== "keeps";
  // Named with the node's OWN name, so the sentences that must name a machine
  // read "…if nobody logs in to blade-01" — this is a page about a machine the
  // reader is not sitting at, where "this machine" would be the wrong one.
  const comesBack = persistence(
    {
      manager: runtime.service.manager,
      installed: runtime.service.installed,
      enabled: runtime.service.enabled,
      linger: runtime.service.linger,
    },
    node.name,
  );

  return (
    <FactCard title="Runtime">
      <Fact label="Up since">{new Date(runtime.startedAt).toLocaleString()}</Fact>
      <Fact label="Supervised by">{supervisionLine(runtime)}</Fact>
      <Fact label="Comes back">
        {comesBack.sentence}
        {comesBack.fix && <FixLine fix={comesBack.fix} />}
      </Fact>
      <Fact label="tmux">
        {runtime.tmuxPath ? (
          <span className="break-all font-mono text-detail">{runtime.tmuxPath}</span>
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
