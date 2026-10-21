import { expect, it } from "bun:test";
import type { SubshellView } from "@/types/subshell";
import { subshellTree, workspaceSubshellIds } from "../subshell-tree";

function row(id: string, parentSubshellId?: string): SubshellView {
  return { id, crossAgent: !!parentSubshellId, parentSubshellId } as SubshellView;
}
it("keeps helpers under their creator and includes descendants in the workspace section", () => {
  const rows = [row("parent"), row("child", "parent"), row("grandchild", "child"), row("other")];
  const tree = subshellTree(rows);
  expect(tree.roots.map((r) => r.id)).toEqual(["parent", "other"]);
  expect(tree.children.get("parent")?.map((r) => r.id)).toEqual(["child"]);
  expect(workspaceSubshellIds(rows, new Set(["parent"]))).toEqual(new Set(["parent", "child", "grandchild"]));
});
it("never promotes old helpers, missing parents, or malformed cycles to standalone entries", () => {
  const old = { ...row("old"), crossAgent: true };
  const rows = [old, row("orphan", "hidden"), row("self", "self"), row("a", "b"), row("b", "a")];
  expect(subshellTree(rows).roots).toEqual([]);
  expect(workspaceSubshellIds(rows, new Set(["a"]))).toEqual(new Set(["a"]));
});

it("keeps a helper nested even after it becomes a workspace tab", () => {
  const rows = [row("parent"), row("child", "parent")];
  const visible = workspaceSubshellIds(rows, new Set(["parent", "child"]));
  const tree = subshellTree(rows.filter((r) => visible.has(r.id)));
  expect(tree.roots.map((r) => r.id)).toEqual(["parent"]);
  expect(tree.children.get("parent")?.map((r) => r.id)).toEqual(["child"]);
});
