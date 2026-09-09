import type { Node } from "@/types/node";

/**
 * The ONE spelling of "this node is a down agent" on the web side: the
 * offline rule covers agents only — `local`'s status is a projection that
 * never gates (mirrors the server's liveness check). Pickers' disabled
 * states, the " (offline)" label, the compat matrix (`lib/subshell-compat`)
 * and the launch hints all derive from this so they cannot disagree about
 * what offline means.
 * @param node - Any node row (list or detail)
 */
export function isOfflineAgent(node: Pick<Node, "kind" | "status">): boolean {
  return node.kind === "agent" && node.status === "offline";
}

/**
 * The option label for a node in a picker: the node's OWN name — an admin- or
 * owner-chosen string for every kind, the control-plane host included — plus a
 * ` · {os}/{arch}` platform suffix when the node has reported both (a young
 * agent's ready may still be in flight), with " (offline)" kept as the LAST
 * segment, because a disabled option still needs to explain itself.
 *
 * It reads `name` for every kind on purpose. This used to take the local
 * label from its CALLER, and four callers each passed their own hardcoded
 * string — so renaming the control-plane host's node reached the Nodes page
 * and silently missed the launch picker, the profile pin, the clone dialog and
 * the compat matrix. Kept as one function so the disabled-state wording (spec
 * §5.6) cannot drift between the pickers; the e2e-pinned item text and the
 * Base UI `items` map must render the SAME string, so both call this.
 *
 * @param node - The node row from `GET /api/nodes`
 */
export function nodeOptionLabel(node: Pick<Node, "kind" | "status" | "name" | "os" | "arch">): string {
  // "mac-mini · darwin/arm64" — only when the node actually reported both
  // (a young agent's ready may still be in flight).
  const platform = node.os !== null && node.arch !== null ? ` · ${node.os}/${node.arch}` : "";
  const offline = isOfflineAgent(node) ? " (offline)" : "";
  return `${node.name}${platform}${offline}`;
}
