import type { Node } from "@/types/node";

/**
 * The option label for a node in a picker: the local machine renders under a
 * caller-chosen friendly name (the launch picker says "Local", the profile pin
 * says "Local (this host)"), an online agent under its own name, and an offline
 * agent with the " — offline" suffix — a disabled option still needs to explain
 * itself. Each label carries a ` · {os}/{arch}` platform suffix when the node
 * has reported both (a young agent's ready may still be in flight), with
 * " — offline" kept as the LAST segment. Kept as one function so the
 * disabled-state wording (spec §5.6) cannot drift between the pickers; the
 * e2e-pinned item text and the Base UI `items` map must render the SAME string,
 * so both call this.
 * @param node - The node row from `GET /api/nodes`
 * @param localLabel - The label for the control-plane host's own entry
 */
export function nodeOptionLabel(
  node: Pick<Node, "kind" | "status" | "name" | "os" | "arch">,
  localLabel: string,
): string {
  const base = node.kind === "local" ? localLabel : node.name;
  // "mac-mini · darwin/arm64" — only when the node actually reported both
  // (a young agent's ready may still be in flight).
  const platform = node.os !== null && node.arch !== null ? ` · ${node.os}/${node.arch}` : "";
  const offline = node.kind === "agent" && node.status === "offline" ? " — offline" : "";
  return `${base}${platform}${offline}`;
}
