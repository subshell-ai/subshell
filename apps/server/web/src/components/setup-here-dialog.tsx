import { apiFetch, Button, NODES_QUERY_KEY } from "@internal/node-admin";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { JSX } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SubshellView } from "@/types/subshell";

/**
 * "Set up Subshell here" (spec 2026-10-08 §7, Task 14): the secondary act
 * on an open SSH-terminal pane that turns its destination into an enrolled
 * node. The server runs the ordinary enrollment install over a separate
 * non-interactive connection - the pane keeps running, and the enrollment
 * key never enters it. The dialog asks once, holds itself open through the
 * install (minutes are possible and the request answers only when the new
 * node is ONLINE), then says which of the two happened in the server's own
 * named words: the machine's id and page on success, the refusal's sentence
 * on failure. Every stage the server can name (no egress, tmux missing,
 * the key home offline, no ready) is a refusal sentence, so the dialog
 * never needs its own failure taxonomy.
 *
 * Owner-only by the menu's gate (an SSH pane is input-reserved to its
 * owner, and this act enrolls a machine on the owner's account); the server
 * re-checks both doors.
 */
export function SetupHereDialog({
  subshell,
  open,
  onOpenChange,
}: {
  /** The SSH-terminal pane whose destination is being set up */
  subshell: SubshellView;
  /** Controlled open state, owned by the actions menu (clone-dialog posture) */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const upgrade = useMutation({
    mutationFn: () =>
      apiFetch<{ nodeId: string }>("/api/ssh/setup-here", {
        method: "POST",
        body: JSON.stringify({ paneId: subshell.id }),
      }),
    onSuccess: () => {
      // The new row belongs to the machine list; the panes queries are
      // untouched because the act never writes the pane.
      void queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY });
    },
  });
  const enrolled = upgrade.data;

  return (
    <Dialog open={open} onOpenChange={(next) => !upgrade.isPending && onOpenChange(next)}>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Set up Subshell here?</DialogTitle>
          {!enrolled && !upgrade.error && (
            <DialogDescription>
              Runs the Subshell installer on the connected machine using this pane's authorization. It enrolls as a node
              you own; the connection and this pane keep running.
            </DialogDescription>
          )}
        </DialogHeader>
        {upgrade.isPending && (
          <p className="text-detail text-muted-foreground">
            Installing on the destination; the download can take a few minutes.
          </p>
        )}
        {upgrade.error && <p className="text-destructive text-detail">{(upgrade.error as Error).message}</p>}
        {enrolled && (
          <p className="text-detail text-success">
            The machine enrolled and connected.{" "}
            <Link
              to="/nodes/$id"
              params={{ id: enrolled.nodeId }}
              className="underline"
              onClick={() => onOpenChange(false)}
            >
              Open its page
            </Link>{" "}
            to see what it can launch.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={upgrade.isPending} onClick={() => onOpenChange(false)}>
            {enrolled ? "Done" : "Cancel"}
          </Button>
          {!enrolled && (
            <Button disabled={upgrade.isPending} onClick={() => void upgrade.mutate()}>
              {upgrade.isPending ? "Setting up…" : "Set up Subshell"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
