import type { Node } from "@internal/node-admin";

/**
 * The Nodes page's three filter axes, page state (the home page's machine
 * filter precedent: filters narrow the table and do not go in the URL; the
 * setup-keys tab does). Pure — all page logic lives here so the component stays glue.
 */
export interface NodeFilters {
  /** Substring of name or hostname (id when hostname is null), case-insensitive. */
  query: string;
  status: "all" | "online" | "offline";
  access: "all" | "yours" | "shared";
}

export const NODE_FILTERS_OFF: NodeFilters = { query: "", status: "all", access: "all" };

export function filterNodes(nodes: readonly Node[], f: NodeFilters): Node[] {
  const q = f.query.trim().toLowerCase();
  return nodes.filter(
    (n) =>
      (f.status === "all" || n.status === f.status) &&
      (f.access === "all" || (f.access === "yours" ? n.access === "owner" : n.access !== "owner")) &&
      (q === "" || n.name.toLowerCase().includes(q) || (n.hostname ?? n.id).toLowerCase().includes(q)),
  );
}
