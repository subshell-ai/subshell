import type { ReactNode } from "react";
import { EntityCard } from "@/components/entity-card";
import { SessionActionsMenu } from "@/components/session-actions-menu";
import { TerminalPreview } from "@/components/terminal-preview";
import { Badge } from "@/components/ui/badge";
import { WaitingChip } from "@/components/waiting-chip";
import { useNodes } from "@/hooks/use-nodes";
import { isWaiting } from "@/lib/session-order";
import type { Node } from "@/types/node";
import type { SessionView } from "@/types/session";

const ACTIVITY_LABEL: Record<SessionView["activity"], string> = {
  active: "working",
  idle: "idle",
  terminated: "ended",
};
const ACTIVITY_VARIANT: Record<SessionView["activity"], "success" | "warning" | "muted"> = {
  active: "success",
  idle: "warning",
  terminated: "muted",
};

/**
 * The card's corner badge: `node unreachable` outranks `exited`, which
 * outranks `waiting for you`, which outranks the plain activity chip. An
 * unreachable node supersedes both lower arms because neither is knowable
 * from here — the agent is down, so `alive`/`waitingSince` are last-known
 * facts, not current state (spec 2026-08-31 §5.6: the session may still be
 * running there). (An exited session is never waiting — `isWaiting` requires
 * `alive` — so those two arms are disjoint anyway.) `exited`/`nodeOffline`
 * are computed once by {@link SessionCard} and passed in — they drive the
 * body's exit rows too.
 */
function accessoryFor(session: SessionView, exited: boolean, nodeOffline: boolean): ReactNode {
  if (nodeOffline) return <Badge variant="warning">node unreachable</Badge>;
  if (exited) return <Badge variant="muted">exited</Badge>;
  if (isWaiting(session)) return <WaitingChip session={session} />;
  return <Badge variant={ACTIVITY_VARIANT[session.activity]}>{ACTIVITY_LABEL[session.activity]}</Badge>;
}

/**
 * The subtitle node pill for a REMOTE session — where the process runs when
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
function nodePill(session: SessionView, known: Node | undefined, pending: boolean): ReactNode {
  if (!session.nodeId || session.nodeId === "local") return null;
  if (!known && pending) {
    return (
      <Badge variant="muted" title={session.nodeId}>
        {session.nodeId.slice(0, 8)}
      </Badge>
    );
  }
  return <Badge variant="muted">{known ? known.name : "deleted node"}</Badge>;
}

/**
 * Card for a session: name, harness, activity chip, a live view of the
 * session's screen, and an actions menu — all on the shared `EntityCard`
 * shell the workspace/profile grids use. The menu is passed through the
 * `menu` slot because `SessionActionsMenu` carries its own state (notes
 * dialog, lifecycle mutations) rather than a plain `items` list.
 *
 * The preview is the session's actual terminal screen, captured server-side
 * and refreshed by the same feed that drives the rest of the page, so a wall
 * of these updates in near-real time without a socket or a terminal emulator
 * each. It is deliberately inert — the whole card is a link to the session,
 * and the preview passes clicks straight through to it.
 */
export function SessionCard({ session }: { session: SessionView }) {
  const preview = session.preview ?? [];
  const note = session.notes;
  const exited = session.status === "running" && !session.alive;
  // Remote + no live agent: everything "exited" would claim is unknowable
  // right now (spec §5.6), so the offline reading supersedes it everywhere.
  const nodeOffline = session.nodeOffline === true;
  // Names-only lookup over the shared nodes query (already cached for the
  // pickers). While it's in flight the pill shows the raw id, not a verdict;
  // a failed list still reads as "unknown id", the same as a genuinely
  // deleted node, and the pill refreshes when data lands.
  const { data: nodeData, isPending } = useNodes();
  const knownNode = session.nodeId ? nodeData?.nodes.find((n) => n.id === session.nodeId) : undefined;

  return (
    <EntityCard
      to="/sessions/$id"
      params={{ id: session.id }}
      title={session.name}
      description={session.harnessId}
      menu={<SessionActionsMenu session={session} />}
      accessory={accessoryFor(session, exited, nodeOffline)}
      // A session is a process *somewhere*, so the directory and (for remote
      // rows) the node pill ride in the subtitle block with the harness —
      // the preview area below stays purely about output.
      headerExtra={
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs" title={session.workingDir}>
            {session.workingDir}
          </p>
          {nodePill(session, knownNode, isPending)}
        </div>
      }
    >
      {/* Fixed height whatever the state, so cards in a row stay the
          same size and a session going quiet doesn't resize the grid.
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
          <p className="truncate p-1 font-mono text-muted-foreground text-xs">
            {nodeOffline
              ? "no screen — the node is offline"
              : exited
                ? "no screen — session has exited"
                : "waiting for first output…"}
          </p>
        )}
      </div>
      {exited && !nodeOffline && (
        <p className="truncate text-muted-foreground text-xs">
          exit: {session.exitCode != null ? session.exitCode : "no exit code"}
          {session.backoffCount > 0 && ` · restart ${session.backoffCount}`}
        </p>
      )}
      {note && <p className="truncate pt-1 text-primary/80 text-xs">note: {note}</p>}
    </EntityCard>
  );
}
