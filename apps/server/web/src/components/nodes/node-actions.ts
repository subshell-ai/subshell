import type { Node } from "@internal/node-admin";
import { Settings, Share2, Trash2, Wrench } from "lucide-react";
import type { ActionItem } from "@/components/actions-menu";

/**
 * The one menu for one node, shared by the card row and the table row.
 *
 * The list grew a second view, and every item here carries a SERVER-derived
 * gate (`canManage`, `kind === "local"`) and a destructive flag that pairs
 * with a confirmation two files away. Two copies of that list is two chances
 * for the table to grey what the card does not, or to offer Delete on
 * `local`, so the list is defined once and both views call it. Entity
 * knowledge still belongs to the caller — every handler is passed in, and
 * the menu stays free of route and mutation knowledge exactly as before.
 *
 * @param node - The row's node, source of every gate
 * @param handlers - What each item does, decided by the page
 */
export function nodeActions(
  node: Node,
  handlers: {
    onOpenConfig: () => void;
    onShare: () => void;
    onMaintenance: () => void;
    onDelete: () => void;
  },
): ActionItem[] {
  return [
    { label: "Open config", icon: Settings, onSelect: handlers.onOpenConfig },
    { label: "Share", icon: Share2, onSelect: handlers.onShare, disabled: !node.canManage },
    {
      // Ending only widens what the machine accepts, so it is not
      // destructive and asks nothing; starting stops every subshell here,
      // including ones this viewer cannot see — hence the red and the
      // ellipsis promising a confirmation.
      label: node.maintenance ? "End maintenance" : "Start maintenance…",
      icon: Wrench,
      onSelect: handlers.onMaintenance,
      disabled: !node.canManage,
      destructive: !node.maintenance,
    },
    {
      label: "Delete",
      icon: Trash2,
      destructive: true,
      onSelect: handlers.onDelete,
      disabled: !node.canManage || node.kind === "local",
    },
  ];
}
