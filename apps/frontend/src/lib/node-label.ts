import type { Node } from "@/types/node";

/**
 * The option label for a node in a picker: the local machine renders under a
 * caller-chosen friendly name (the launch picker says "Local", the profile pin
 * says "Local (this host)"), an online agent under its own name, and an offline
 * agent with the " — offline" suffix — a disabled option still needs to explain
 * itself. Kept as one function so the disabled-state wording (spec §5.6) cannot
 * drift between the pickers; the e2e-pinned item text and the Base UI `items`
 * map must render the SAME string, so both call this.
 * @param node - The node row from `GET /api/nodes`
 * @param localLabel - The label for the control-plane host's own entry
 */
export function nodeOptionLabel(node: Pick<Node, "kind" | "status" | "name">, localLabel: string): string {
  if (node.kind === "local") return localLabel;
  return node.status === "online" ? node.name : `${node.name} — offline`;
}
