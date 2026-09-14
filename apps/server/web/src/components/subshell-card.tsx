import type { ReactNode } from "react";
import { EntityCard } from "@/components/entity-card";
import { SubshellActionsMenu } from "@/components/subshell-actions-menu";
import { TerminalPreview } from "@/components/terminal-preview";
import { Badge } from "@/components/ui/badge";
import { WaitingChip } from "@/components/waiting-chip";
import { useNodes } from "@/hooks/use-nodes";
import { INDICATOR_LABEL, INDICATOR_VARIANT, subshellIndicator } from "@/lib/subshell-indicator";
import type { Node } from "@/types/node";
import type { SubshellView } from "@/types/subshell";

/**
 * The card's corner badge: delegates the state to the shared
 * `subshellIndicator` precedence (node unreachable → exited → waiting-for-you
 * → activity — see lib/subshell-indicator.ts) and renders it. `WaitingChip`
 * self-guards, but the indicator branch keeps it explicit: the waiting arm
 * outranks the plain activity chip.
 */
function accessoryFor(subshell: SubshellView): ReactNode {
  const indicator = subshellIndicator(subshell);
  if (indicator === "node-offline") return <Badge variant="warning">{INDICATOR_LABEL["node-offline"]}</Badge>;
  if (indicator === "exited") return <Badge variant="muted">{INDICATOR_LABEL.exited}</Badge>;
  if (indicator === "waiting") return <WaitingChip subshell={subshell} />;
  return <Badge variant={INDICATOR_VARIANT[indicator]}>{INDICATOR_LABEL[indicator]}</Badge>;
}

/**
 * The subtitle node pill for a REMOTE subshell — where the process runs when
 * that isn't the control-plane host. The name rides the shared `useNodes()`
 * cache (one query, names only); an id the registry no longer holds is a
 * deleted node, said plainly — but only once the registry has ANSWERED.
 * While the list is still in flight, absence proves nothing, so the pill
 * wears the raw short id (a cold `/` must not flash "deleted node" at every
 * remote card before the fetch lands). A FAILED list is indistinguishable
 * from a vanished one from here, so it still reads "deleted node".
 * Identity only: the offline STATE renders as the corner badge (see
 * {@link accessoryFor}), so a downed node's card spells "node unreachable"
 * exactly once.
 */
function nodePill(subshell: SubshellView, known: Node | undefined, pending: boolean): ReactNode {
  if (!subshell.nodeId || subshell.nodeId === "local") return null;
  if (!known && pending) {
    return (
      <Badge variant="muted" title={subshell.nodeId}>
        {subshell.nodeId.slice(0, 8)}
      </Badge>
    );
  }
  return <Badge variant="muted">{known ? known.name : "deleted node"}</Badge>;
}

/**
 * Card for a subshell: name, harness, activity chip, a live view of the
 * subshell's screen, and an actions menu — all on the shared `EntityCard`
 * shell the workspace grid uses. The menu is passed through the
 * `menu` slot because `SubshellActionsMenu` carries its own state (title
 * dialog, lifecycle mutations) rather than a plain `items` list.
 *
 * The preview is the subshell's actual terminal screen, captured server-side
 * and refreshed by the same feed that drives the rest of the page, so a wall
 * of these updates in near-real time without a socket or a terminal emulator
 * each. It is deliberately inert — the whole card is a link to the subshell,
 * and the preview passes clicks straight through to it.
 */
export function SubshellCard({ subshell }: { subshell: SubshellView }) {
  const preview = subshell.preview ?? [];
  const exited = subshell.status === "running" && !subshell.alive;
  // Remote + no live agent: everything "exited" would claim is unknowable
  // right now (spec §5.6), so the offline reading supersedes it everywhere.
  const nodeOffline = subshell.nodeOffline === true;
  // Names-only lookup over the shared nodes query (already cached for the
  // pickers). While it's in flight the pill shows the raw id, not a verdict;
  // a failed list still reads as "unknown id", the same as a genuinely
  // deleted node, and the pill refreshes when data lands.
  const { data: nodeData, isPending } = useNodes();
  const knownNode = subshell.nodeId ? nodeData?.nodes.find((n) => n.id === subshell.nodeId) : undefined;

  return (
    <EntityCard
      to="/subshells/$id"
      params={{ id: subshell.id }}
      title={subshell.name}
      description={subshell.harnessId}
      menu={<SubshellActionsMenu subshell={subshell} />}
      accessory={accessoryFor(subshell)}
      // A subshell is a process *somewhere*, so the directory and (for remote
      // rows) the node pill ride in the subtitle block with the harness —
      // the preview area below stays purely about output.
      headerExtra={
        <div className="flex min-w-0 items-center gap-2">
          <p
            className="min-w-0 flex-1 truncate font-mono text-detail text-muted-foreground"
            title={subshell.workingDir}
          >
            {subshell.workingDir}
          </p>
          {nodePill(subshell, knownNode, isPending)}
        </div>
      }
    >
      {/* Fixed height whatever the state, so cards in a row stay the
          same size and a subshell going quiet doesn't resize the grid.
          Content is anchored to the bottom because that is where a
          terminal keeps it — the prompt sits at the foot of the screen
          and output grows upward — so a short screen reads as a
          terminal at rest rather than as a half-empty box — and any
          overflow is clipped off the top, so the newest output is the
          part that survives. */}
      <div className="flex h-60 flex-col justify-end overflow-hidden rounded border border-border/50 bg-terminal-canvas p-1.5">
        {preview.length > 0 ? (
          <TerminalPreview lines={preview} />
        ) : (
          <p className="truncate p-1 font-mono text-detail text-muted-foreground">
            {nodeOffline
              ? "no screen (the node is offline)"
              : exited
                ? "no screen (subshell has exited)"
                : "waiting for first output…"}
          </p>
        )}
      </div>
      {exited && !nodeOffline && (
        <p className="truncate text-detail text-muted-foreground">
          exit: {subshell.exitCode != null ? subshell.exitCode : "no exit code"}
          {subshell.backoffCount > 0 && ` · restart ${subshell.backoffCount}`}
        </p>
      )}
    </EntityCard>
  );
}
