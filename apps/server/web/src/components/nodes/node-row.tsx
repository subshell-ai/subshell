import type { Node } from "@internal/node-admin";
import { Badge, badgeVariants, cn, relativeElapsed } from "@internal/node-admin";
import { Settings, Share2, Trash2, Wrench } from "lucide-react";
import { useState } from "react";
import { ActionsMenu } from "@/components/actions-menu";

/**
 * OS label (spec 2026-08-31 §9): darwin reads as "Apple" (the honest brand of
 * the only darwin targets we ship for), linux as "Linux"; anything else is
 * rendered raw — an unrecognised value is worth seeing, not smoothing over.
 */
export function osLabel(os: string | null): string {
  if (os === "darwin") return "Apple";
  if (os === "linux") return "Linux";
  return os ?? "unknown";
}

/**
 * How many harness chips ride inline before the rest go behind "+N more".
 *
 * The harness list is the only part of this row whose LENGTH varies — every
 * other badge is one chip or none — so it is the only part that is truncated.
 */
const INLINE_HARNESSES = 3;

/**
 * One row of the Nodes list: name + hostname line, the OS/arch chip, the
 * status badge, chips for the harnesses whose program was detected, the access badge, and
 * the overflow menu. Delete/Share are gated on `node.canManage` — the
 * SERVER's answer (real owner, or admin on `local`) so admins keep the
 * surfaces the routes actually let them use; shown DISABLED rather than
 * hidden for non-managers so the row reads the same to everyone. `local` is
 * undeletable server-side, so its Delete is disabled even for a manager.
 *
 * The second line is the node's HOSTNAME for every kind. The control-plane
 * host used to read "this machine" here, which is false for every user who is
 * not sitting at it — and it is the one row a person is most likely to
 * misread as their own laptop.
 *
 * **Three columns: identity, chips, menu — and only the middle one moves.**
 * This was one flat wrapping row, which made both fixed things accidental.
 * The name was `flex-1` off a zero basis with no minimum while no chip could
 * shrink, so a node with six detected harnesses squeezed it to roughly one
 * character — a letter per line under an ellipsis. The menu looked
 * right-aligned only because that stretching pushed it there, so it drifted to
 * wherever the last chip left it the moment the row wrapped. Both are columns
 * now, fixed-width and unshrinkable, and wrapping is contained in the middle
 * column alone.
 *
 * Only the harness chips truncate, behind "+N more": the OS/arch, status,
 * `maintenance`, `inventory stale` and ownership badges are each one chip of
 * fixed shape, and a WARNING must never hide behind a "more" control.
 */
export function NodeRow({
  node,
  onOpenConfig,
  onShare,
  onDelete,
  onMaintenance,
}: {
  /** The node to render */
  node: Node;
  /** Open this node's config page */
  onOpenConfig: () => void;
  /** Open this node's sharing management (owner-only server-side) */
  onShare: () => void;
  /** Delete this node (owner-only server-side) */
  onDelete: () => void;
  /**
   * Start or end maintenance on this node — which of the two is decided by
   * `node.maintenance`, the same flag that labels the item.
   *
   * The confirmation and the PUT belong to the caller, like every other item
   * here: starting maintenance needs a count this row's payload does not
   * carry (`runningSubshells` rides the detail view), so the asking happens
   * where the number can be fetched.
   */
  onMaintenance: () => void;
}) {
  const isOwner = node.access === "owner";
  // Row-local and deliberately unpersisted: it is a look at one row, not a
  // preference about the page.
  const [showAllHarnesses, setShowAllHarnesses] = useState(false);
  const installed = node.harnesses.filter((h) => h.installed);
  const overflowCount = Math.max(0, installed.length - INLINE_HARNESSES);
  const visible = showAllHarnesses ? installed : installed.slice(0, INLINE_HARNESSES);
  return (
    <div className="flex items-start gap-3 rounded-lg border p-3">
      {/* Column 1: identity. A fixed width rather than a flexible one, so the
          name occupies the same place in every row of the list and a node with
          many chips cannot move it. `min-w-0` is what lets `truncate` act — a
          flex child's automatic minimum is its content, so without it a long
          name widens this column instead of ellipsing inside it. */}
      <div className="w-40 min-w-0 shrink-0 sm:w-48">
        <p className="truncate font-strong">{node.name}</p>
        <p className="truncate text-detail text-muted-foreground">
          {node.hostname ?? node.id}
          {node.lastSeenAt ? ` · seen ${relativeElapsed(node.lastSeenAt)}` : ""}
          {node.agentVersion ? ` · v${node.agentVersion}` : ""}
        </p>
      </div>

      {/* Column 2: the only part that flexes, and the only part that wraps.
          Wrapping is contained HERE rather than on the row, which is what
          keeps the other two columns still: the chips run onto a second line
          without dragging the menu down the row or squeezing the name. */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-muted-foreground">
          {osLabel(node.os)}
          {node.arch ? ` · ${node.arch}` : ""}
        </Badge>
        <Badge variant={node.status === "online" ? "success" : "muted"}>{node.status}</Badge>
        {/* Beside the status rather than among the harness chips, for the
            reason the docblock gives: this is a warning, and a warning that
            needs a click to be seen is not one. A node in maintenance looks
            entirely healthy otherwise — `online`, every harness detected —
            so without this chip the row says nothing about why nobody can
            launch there. */}
        {node.maintenance && <Badge variant="warning">maintenance</Badge>}
        {node.inventoryStale && <Badge variant="warning">inventory stale</Badge>}
        {visible.map((h) => (
          <Badge key={h.harnessId} variant="outline" className="border-emerald-500/50 text-emerald-400">
            {h.harnessId}
          </Badge>
        ))}
        {overflowCount > 0 && (
          <button
            type="button"
            aria-expanded={showAllHarnesses}
            onClick={() => setShowAllHarnesses((open) => !open)}
            className={cn(
              badgeVariants({ variant: "outline" }),
              "cursor-pointer text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            )}
          >
            {showAllHarnesses ? "Show fewer" : `+${overflowCount} more`}
          </button>
        )}
        {isOwner ? <Badge variant="muted">yours</Badge> : <Badge variant="secondary">shared · {node.access}</Badge>}
      </div>

      {/* Column 3: the menu, in the same place in every row whatever the
          middle column does. It used to sit last in one flat wrapping row,
          where its right-hand position was a side effect of the name block
          stretching — so it drifted to wherever the last chip left it as soon
          as the row wrapped. A column of its own is the thing that was
          actually wanted. */}
      <div className="shrink-0">
        <ActionsMenu
          label={node.name}
          items={[
            { label: "Open config", icon: Settings, onSelect: onOpenConfig },
            { label: "Share", icon: Share2, onSelect: onShare, disabled: !node.canManage },
            {
              // Ending only widens what the machine accepts, so it is not
              // destructive and asks nothing; starting stops every subshell
              // here, including ones this viewer cannot see — hence the red
              // and the ellipsis promising a confirmation.
              label: node.maintenance ? "End maintenance" : "Start maintenance…",
              icon: Wrench,
              onSelect: onMaintenance,
              disabled: !node.canManage,
              destructive: !node.maintenance,
            },
            {
              label: "Delete",
              icon: Trash2,
              destructive: true,
              onSelect: onDelete,
              disabled: !node.canManage || node.kind === "local",
            },
          ]}
        />
      </div>
    </div>
  );
}
