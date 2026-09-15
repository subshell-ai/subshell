import { Settings, Share2, Trash2 } from "lucide-react";
import { useState } from "react";
import { ActionsMenu } from "@/components/actions-menu";
import { relativeElapsed } from "@/components/subshell-status";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Node } from "@/types/node";

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
 * **The name block has a floor, and the harness chips are what give way.** The
 * row wraps, and the name block used to be `flex-1` off a zero basis with no
 * minimum while no badge could shrink — so a node with six detected harnesses
 * squeezed the name to roughly one character, rendering a letter per line
 * under an ellipsis. `min-w-48` is the floor (the badges wrap below the name
 * instead of crushing it), and only the harness chips are truncated: the
 * OS/arch, status, `inventory stale` and ownership badges are each one chip
 * of fixed shape, and a WARNING must never hide behind a "more" control.
 */
export function NodeRow({
  node,
  onOpenConfig,
  onShare,
  onDelete,
}: {
  /** The node to render */
  node: Node;
  /** Open this node's config page */
  onOpenConfig: () => void;
  /** Open this node's sharing management (owner-only server-side) */
  onShare: () => void;
  /** Delete this node (owner-only server-side) */
  onDelete: () => void;
}) {
  const isOwner = node.access === "owner";
  // Row-local and deliberately unpersisted: it is a look at one row, not a
  // preference about the page.
  const [showAllHarnesses, setShowAllHarnesses] = useState(false);
  const installed = node.harnesses.filter((h) => h.installed);
  const overflowCount = Math.max(0, installed.length - INLINE_HARNESSES);
  const visible = showAllHarnesses ? installed : installed.slice(0, INLINE_HARNESSES);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border p-3">
      <div className="min-w-48 flex-1">
        <p className="truncate font-strong">{node.name}</p>
        <p className="truncate text-detail text-muted-foreground">
          {node.hostname ?? node.id}
          {node.lastSeenAt ? ` · seen ${relativeElapsed(node.lastSeenAt)}` : ""}
          {node.agentVersion ? ` · v${node.agentVersion}` : ""}
        </p>
      </div>

      <Badge variant="outline" className="text-muted-foreground">
        {osLabel(node.os)}
        {node.arch ? ` · ${node.arch}` : ""}
      </Badge>
      <Badge variant={node.status === "online" ? "success" : "muted"}>{node.status}</Badge>
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

      <ActionsMenu
        label={node.name}
        items={[
          { label: "Open config", icon: Settings, onSelect: onOpenConfig },
          { label: "Share", icon: Share2, onSelect: onShare, disabled: !node.canManage },
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
  );
}
