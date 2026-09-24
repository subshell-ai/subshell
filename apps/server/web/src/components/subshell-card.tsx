import { EntityCard } from "@/components/entity-card";
import { SubshellActionsMenu } from "@/components/subshell-actions-menu";
import { SubshellDot } from "@/components/subshell-dot";
import { TerminalPreview } from "@/components/terminal-preview";
import type { SubshellView } from "@/types/subshell";

/**
 * Card for a subshell: name, harness, status dot, a live view of the
 * subshell's screen, and an actions menu — all on the shared `EntityCard`
 * shell the workspace grid uses. The menu is passed through the
 * `menu` slot because `SubshellActionsMenu` carries its own state (title
 * dialog, lifecycle mutations) rather than a plain `items` list.
 *
 * The status dot is the SAME dot the rail and the subshell page header draw
 * (2026-09-24, replacing the text chips), and it LEADS the title there as it
 * does here: one component, one state, one position (operator ask, same day
 * — it sat on the title's right and read as a different thing in a grid of
 * rows that all say it on the left). It is `accessible` here because the dot
 * is the only thing on the card carrying the state word — the label rides the
 * link's accessible name exactly where the badge's text used to read.
 *
 * The card carries NO machine badge any more (2026-09-24): the tile grid it
 * sits in is segmented by machine, the way the sidebar's recents are, so
 * the section header answers "which machine" for every card at once — on
 * the same label ladder (see lib/subshell-node-groups.ts), `local`
 * included.
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
  // Remote + no live node: everything "exited" would claim is unknowable
  // right now (spec §5.6), so the offline reading supersedes it everywhere.
  const nodeOffline = subshell.nodeOffline === true;

  return (
    <EntityCard
      to="/subshells/$id"
      params={{ id: subshell.id }}
      title={subshell.name}
      description={subshell.harnessId}
      menu={<SubshellActionsMenu subshell={subshell} />}
      accessory={<SubshellDot subshell={subshell} accessible className="mt-0" />}
      // A subshell is a process *somewhere*, so the directory rides in the
      // subtitle block with the harness — the preview area below stays
      // purely about output. (The machine used to sit here as a pill; the
      // grid's section header carries that now.)
      headerExtra={
        <p className="truncate font-mono text-detail text-muted-foreground" title={subshell.workingDir}>
          {subshell.workingDir}
        </p>
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
