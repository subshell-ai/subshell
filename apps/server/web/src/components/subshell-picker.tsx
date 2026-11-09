import { useLocation, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { type JSX, useEffect, useState } from "react";
import { AddSubshellDialog } from "@/components/subshell-picker/add-subshell-dialog";
import { TippedIconButton } from "@/components/tipped-icon-button";
import { useIsStackedHeader } from "@/hooks/use-is-stacked-header";
import type { SplitDirection, WorkspacePaneRow } from "@/types/workspace";

/** Props for {@link SubshellPicker}. */
export interface SubshellPickerProps {
  /**
   * The workspace receiving the selected subshell. Also scopes sidebar
   * requests to open this dialog; pane mutations go through `onAdd`.
   */
  workspaceId: string;
  /** Panes already on this workspace; their subshells are excluded from the list */
  existing: WorkspacePaneRow[];
  /**
   * Adds `subshellId` to the workspace at `direction`. Every entry point in
   * this component funnels through this one callback, so there is exactly
   * one place that actually adds a pane.
   */
  onAdd: (subshellId: string, direction: SplitDirection) => Promise<unknown>;
}

/**
 * The "Add subshell" button on a workspace, and the dialog it opens.
 *
 * Search keeps larger collections usable. Additions open as tabs; desktop
 * users can drag them to arrange splits.
 */
export function SubshellPicker({ workspaceId, existing, onAdd }: SubshellPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const requested = location.search.picker === true;
  useEffect(() => {
    if (!requested) return;
    setOpen(true);
    // Consume the sidebar request without adding another browser history entry.
    void navigate({
      to: "/workspaces/$id",
      params: { id: workspaceId },
      search: (previous) => ({ add: previous.add, dir: previous.dir }),
      replace: true,
    });
  }, [requested, workspaceId, navigate]);
  // The control is icon-only at every width, like the rest of the pane bar
  // (see `pane-focus-header`). The stacked (phone) header shares its top row
  // with Save/Discard and the nav chrome, so there it also loses the pill
  // weight and sits as a plain icon button.
  const stacked = useIsStackedHeader();

  return (
    <>
      {stacked ? (
        <TippedIconButton tooltip="Add a subshell to this workspace" size="icon" onClick={() => setOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
        </TippedIconButton>
      ) : (
        // size="sm" stays deliberate even glyph-only: its horizontal padding
        // keeps the pill shape. The icon sizes are squares and would flatten
        // this wide branch into the stacked one's look.
        <TippedIconButton
          tooltip="Add a subshell to this workspace"
          size="sm"
          className="shadow-lg"
          onClick={() => setOpen(true)}
        >
          <Plus className="h-3.5 w-3.5" />
        </TippedIconButton>
      )}
      <AddSubshellDialog
        open={open}
        onOpenChange={setOpen}
        excludeSubshellIds={existing.map((p) => p.subshellId)}
        onAdd={onAdd}
      />
    </>
  );
}
