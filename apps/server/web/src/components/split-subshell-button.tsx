import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { SquareSplitHorizontal } from "lucide-react";
import { type JSX, useState } from "react";
import { AddSubshellDialog } from "@/components/subshell-picker/add-subshell-dialog";
import { Button } from "@/components/ui/button";
import { apiPost } from "@/lib/api";
import { SUBSHELL_WORKSPACES_QUERY_KEY } from "@/lib/query-keys";
import { defaultWorkspaceName } from "@/lib/workspace-name";
import type { SubshellView } from "@/types/subshell";
import type { SplitDirection, WorkspaceRow } from "@/types/workspace";

/**
 * "Split" on a subshell's page: put a second subshell beside this one
 * (spec 2026-09-14 §3).
 *
 * A split pane IS a new subshell, and two subshells side by side ARE a
 * workspace — so this creates one rather than inventing a second tiling
 * concept. It is created as a DRAFT: it holds this subshell already, stays
 * off `/workspaces` and out of the sidebar until it is named, and is thrown
 * away again if it drops below two panes. What the user does here is pick the
 * second pane, which is the existing add-a-pane dialog, unchanged.
 *
 * The pane itself is NOT added here. The `add`/`dir` search params carry the
 * choice into the workspace page, which runs the same `handleAdd` every later
 * add runs — one add path, and the placement lands in the real dockview
 * layout instead of a guess made before it existed.
 */
export function SplitSubshellButton({ subshell }: { subshell: SubshellView }): JSX.Element {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  /**
   * Creates the draft around this subshell and hands the picked second pane
   * to the workspace page. Errors are left to throw: the dialog catches them
   * and keeps itself open with the message, which is the behaviour every
   * other caller of `onAdd` already relies on.
   */
  async function handleAdd(subshellId: string, direction: SplitDirection): Promise<void> {
    const workspace = await apiPost<WorkspaceRow>("/api/workspaces", {
      name: subshell.name || defaultWorkspaceName(),
      draft: true,
      subshellId: subshell.id,
    });
    // This subshell now sits on a workspace — the header's link reads it.
    await queryClient.invalidateQueries({ queryKey: [...SUBSHELL_WORKSPACES_QUERY_KEY, subshell.id] });
    await navigate({
      to: "/workspaces/$id",
      params: { id: workspace.id },
      search: { add: subshellId, dir: direction },
    });
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        aria-label="Split this subshell into a workspace"
        onClick={() => setOpen(true)}
      >
        <SquareSplitHorizontal className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Split</span>
      </Button>
      <AddSubshellDialog
        open={open}
        onOpenChange={setOpen}
        excludeSubshellIds={[subshell.id]}
        // Same plugin, same machine, same directory: a split is almost always
        // "another one of these", and every one of the three is re-pickable.
        initialForm={{
          harnessId: subshell.harnessId,
          nodeId: subshell.nodeId ?? "local",
          workingDir: subshell.workingDir,
        }}
        onAdd={handleAdd}
      />
    </>
  );
}
