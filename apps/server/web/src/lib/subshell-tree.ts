import type { SubshellView } from "@/types/subshell";

/** Helpers appear only beneath visible parents, never as standalone list entries. */
export function subshellTree(rows: readonly SubshellView[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const children = new Map<string, SubshellView[]>();
  const roots: SubshellView[] = [];
  for (const row of rows) {
    const parent = row.crossAgent && row.parentSubshellId ? byId.get(row.parentSubshellId) : undefined;
    const seen = new Set([row.id]);
    let ancestor = parent;
    while (ancestor && !seen.has(ancestor.id)) {
      seen.add(ancestor.id);
      ancestor = ancestor.crossAgent && ancestor.parentSubshellId ? byId.get(ancestor.parentSubshellId) : undefined;
    }
    if (!row.crossAgent) roots.push(row);
    else if (parent && !ancestor) children.set(parent.id, [...(children.get(parent.id) ?? []), row]);
  }
  return { roots, children };
}

/** Include a workspace's members and their visible spawned descendants without changing tab membership. */
export function workspaceSubshellIds(rows: readonly SubshellView[], members: ReadonlySet<string>): Set<string> {
  const ids = new Set(members);
  const { children } = subshellTree(rows);
  const visit = (id: string) => {
    for (const child of children.get(id) ?? []) {
      if (ids.has(child.id)) continue;
      ids.add(child.id);
      visit(child.id);
    }
  };
  for (const id of members) visit(id);
  return ids;
}
