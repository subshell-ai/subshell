import { Plus } from "lucide-react";
import { type JSX, useState } from "react";
import { AddSubshellDialog } from "@/components/subshell-picker/add-subshell-dialog";
import { Button } from "@/components/ui/button";
import type { SplitDirection, WorkspacePaneRow } from "@/types/workspace";

/** Props for {@link SubshellPicker}. */
export interface SubshellPickerProps {
  /**
   * The workspace a picked or newly-created subshell is added to. Not read
   * inside this component — every network call that actually needs it
   * (creating the pane, or looking up the workspace's own panes) already
   * goes through `onAdd` — but part of the contract so a caller never has to
   * wonder whether this picker is scoped to the right workspace.
   */
  workspaceId: string;
  /** Panes already on this workspace; their subshells are excluded from the list */
  existing: WorkspacePaneRow[];
  /**
   * Adds `subshellId` to the workspace at `direction`. Every entry point in
   * this component funnels through this one callback, so there is exactly
   * one place that actually adds a pane.
   */
  onAdd: (subshellId: string, direction: SplitDirection) => Promise<void>;
}

/**
 * The "Add subshell" button on a workspace, and the dialog it opens.
 *
 * It used to be a dropdown with three submenus — one per placement — each
 * listing every subshell, unsearchable. That is fine at four subshells and
 * unusable at forty, so the list moved into a dialog that searches, with the
 * placement chosen once alongside it. It works with a mouse, a finger or a
 * keyboard, which matters because workspaces are used from tablets and
 * phones as well as desktops.
 */
export function SubshellPicker({ existing, onAdd }: SubshellPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        size="sm"
        className="shadow-lg"
        aria-label="Add a subshell to this workspace"
        onClick={() => setOpen(true)}
      >
        <Plus className="h-3.5 w-3.5" /> Add subshell
      </Button>
      <AddSubshellDialog
        open={open}
        onOpenChange={setOpen}
        excludeSubshellIds={existing.map((p) => p.subshellId)}
        onAdd={onAdd}
      />
    </>
  );
}
