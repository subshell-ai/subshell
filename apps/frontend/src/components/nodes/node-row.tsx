import { Settings, Share2, Trash2 } from "lucide-react";
import { ActionsMenu } from "@/components/actions-menu";
import { relativeElapsed } from "@/components/subshell-status";
import { Badge } from "@/components/ui/badge";
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
 * One row of the Nodes list: name + machine line, the OS/arch chip, the
 * status badge, installed-and-enabled harness chips, the access badge, and
 * the overflow menu. Delete/Share are gated on `node.canManage` — the
 * SERVER's answer (real owner, or admin on `local`) so admins keep the
 * surfaces the routes actually let them use; shown DISABLED rather than
 * hidden for non-managers so the row reads the same to everyone. `local` is
 * undeletable server-side, so its Delete is disabled even for a manager.
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
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border p-3">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{node.name}</p>
        <p className="truncate text-muted-foreground text-xs">
          {node.kind === "local" ? "this machine" : (node.hostname ?? node.id)}
          {node.lastSeenAt ? ` · seen ${relativeElapsed(node.lastSeenAt)}` : ""}
          {node.agentVersion ? ` · agent ${node.agentVersion}` : ""}
        </p>
      </div>

      <Badge variant="outline" className="text-muted-foreground">
        {osLabel(node.os)}
        {node.arch ? ` · ${node.arch}` : ""}
      </Badge>
      <Badge variant={node.status === "online" ? "success" : "muted"}>{node.status}</Badge>
      {node.inventoryStale && <Badge variant="warning">inventory stale</Badge>}
      {node.harnesses
        .filter((h) => h.installed && h.enabled)
        .map((h) => (
          <Badge key={h.harnessId} variant="outline" className="border-emerald-500/50 text-emerald-400">
            {h.harnessId}
          </Badge>
        ))}
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
