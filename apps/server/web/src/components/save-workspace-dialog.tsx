import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useInvalidateWorkspaces } from "@/hooks/use-workspaces";
import { ApiError, apiFetch, errMessage } from "@/lib/api";
import { NAME_MAX_DEFAULT } from "@/lib/name-limits";
import { WORKSPACE_QUERY_KEY } from "@/lib/query-keys";
import type { WorkspaceRow } from "@/types/workspace";

/**
 * Names an unsaved (draft) workspace and promotes it — spec 2026-09-14 §4.
 *
 * Promotion is ONE call: `PUT /api/workspaces/:id { name, draft: false }`.
 * There is no second transition — a saved workspace can never become a draft
 * again — so this dialog is the whole "Save as workspace" act, and what it
 * really asks for is the name. The draft already carries one (the root
 * subshell's, which may collide freely while `draft` is set), so the field is
 * prefilled with it and the collision only becomes possible here, which is
 * why the 409 is relabelled rather than shown raw.
 *
 * Controlled, with no trigger of its own: the thing that opens it is a button
 * in `WorkspaceHeader`'s draft branch. Mount it keyed by workspace id so
 * switching workspaces gets a fresh draft name.
 */
export function SaveWorkspaceDialog({
  workspace,
  open,
  onOpenChange,
}: {
  /** The draft being named; its `name` prefills the field */
  workspace: WorkspaceRow;
  /** Dialog open state, owned by the caller */
  open: boolean;
  /** Called on close (Cancel, backdrop, Escape) and after a successful save */
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const invalidateWorkspaces = useInvalidateWorkspaces();
  const [text, setText] = useState(workspace.name);
  const [error, setError] = useState<string | null>(null);

  const trimmed = text.trim();
  const tooLong = trimmed.length > NAME_MAX_DEFAULT;

  const save = useMutation({
    mutationFn: (name: string) =>
      apiFetch(`/api/workspaces/${workspace.id}`, {
        method: "PUT",
        body: JSON.stringify({ name, draft: false }),
      }),
    onSuccess: () => {
      // The open page re-reads the workspace from its detail query (the
      // header's draft branch switches to the editable name off the same
      // row); the list page's cards re-read from the shared list query,
      // which until now excluded this workspace entirely.
      void queryClient.invalidateQueries({ queryKey: [...WORKSPACE_QUERY_KEY, workspace.id] });
      void invalidateWorkspaces();
      onOpenChange(false);
    },
  });

  /** Promotes the draft, re-labelling the duplicate-name 409 as the header's rename does. */
  async function submit(): Promise<void> {
    if (trimmed === "" || tooLong || save.isPending) return;
    setError(null);
    try {
      await save.mutateAsync(trimmed);
    } catch (err) {
      // The STATUS, never the message text: `ApiError`'s message happens to
      // begin "API 409: …" today, but a name carrying "409" would have been
      // relabelled as a collision by a substring match (review, 2026-09-14).
      if (err instanceof ApiError && err.status === 409) {
        setError("You already have a workspace with that name");
        return;
      }
      setError(errMessage(err, "") || "Failed to save");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save workspace</DialogTitle>
          <DialogDescription>
            Name it and it joins your workspaces. The subshells on it are unaffected.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="save-workspace-name">Workspace name</Label>
          <Input
            id="save-workspace-name"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={NAME_MAX_DEFAULT}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </div>
        {tooLong && <p className="text-destructive text-detail">Keep it under {NAME_MAX_DEFAULT} characters</p>}
        {error && <p className="text-destructive text-detail">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={save.isPending || trimmed === "" || tooLong}>
            {save.isPending ? "Saving…" : "Save workspace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
