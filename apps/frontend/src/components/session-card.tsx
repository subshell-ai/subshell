import type { ReactNode } from "react";
import { EntityCard } from "@/components/entity-card";
import { SessionActionsMenu } from "@/components/session-actions-menu";
import { TerminalPreview } from "@/components/terminal-preview";
import { Badge } from "@/components/ui/badge";
import { WaitingChip } from "@/components/waiting-chip";
import { isWaiting } from "@/lib/session-order";
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
 * The card's corner badge: `exited` outranks `waiting for you`, which
 * outranks the plain activity chip. (An exited session is never waiting —
 * `isWaiting` requires `alive` — so the first two arms are disjoint anyway.)
 * `exited` is computed once by {@link SessionCard} and passed in — the
 * predicate already drives the body's exit rows too.
 */
function accessoryFor(session: SessionView, exited: boolean): ReactNode {
  if (exited) return <Badge variant="muted">exited</Badge>;
  if (isWaiting(session)) return <WaitingChip session={session} />;
  return <Badge variant={ACTIVITY_VARIANT[session.activity]}>{ACTIVITY_LABEL[session.activity]}</Badge>;
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

  return (
    <EntityCard
      to="/sessions/$id"
      params={{ id: session.id }}
      title={session.name}
      description={session.harnessId}
      menu={<SessionActionsMenu session={session} />}
      accessory={accessoryFor(session, exited)}
      // A session is a process *somewhere*, so the directory rides in the
      // subtitle block with the harness — the preview area below stays
      // purely about output.
      headerExtra={
        <p className="truncate font-mono text-muted-foreground text-xs" title={session.workingDir}>
          {session.workingDir}
        </p>
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
            {exited ? "no screen — session has exited" : "waiting for first output…"}
          </p>
        )}
      </div>
      {exited && (
        <p className="truncate text-muted-foreground text-xs">
          exit: {session.exitCode != null ? session.exitCode : "no exit code"}
          {session.backoffCount > 0 && ` · restart ${session.backoffCount}`}
        </p>
      )}
      {note && <p className="truncate pt-1 text-primary/80 text-xs">note: {note}</p>}
    </EntityCard>
  );
}
