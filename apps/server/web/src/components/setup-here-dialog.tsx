import { Button } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import { type JSX, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSshSetup } from "@/hooks/use-ssh-setup";
import type { SubshellView } from "@/types/subshell";

/**
 * "Set up Subshell here" (spec 2026-10-08 §7, Task 14): the secondary act
 * on an open SSH-terminal pane that turns its destination into an enrolled
 * node. The server runs the ordinary enrollment install over a separate
 * non-interactive connection - the pane keeps running, and the enrollment
 * key never enters it. The dialog asks once, retains server-side status through the
 * install (minutes are possible), then links to the enrolled machine or
 * explains the failure. Enrollment without a confirmed connection is a
 * distinct outcome: open the node page rather than reinstalling.
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
  const { upgrade, status, operation, pending } = useSshSetup(subshell.id);
  const enrolled = operation?.nodeId
    ? { nodeId: operation.nodeId, connected: operation.stage === "complete" }
    : upgrade.data;
  const error = operation?.error ?? (upgrade.error as Error | null)?.message;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pending]);
  const elapsed = Math.max(
    0,
    Math.floor((now - (operation ? Date.parse(operation.startedAt) : upgrade.submittedAt)) / 1000),
  );
  const stage =
    operation?.stage === "connecting"
      ? "Installed. Waiting for the destination to connect to this server…"
      : operation?.stage === "checking"
        ? "Checking access and preparing installation…"
        : "Installing on the destination; the download can take a few minutes.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Set up Subshell here?</DialogTitle>
          {!enrolled && !error && (
            <DialogDescription>
              Runs the Subshell installer on the connected machine using this pane's authorization. It enrolls as a node
              you own; the connection and this pane keep running.
            </DialogDescription>
          )}
        </DialogHeader>
        {pending && (
          <div className="flex flex-col gap-2">
            <p role="status" className="text-detail text-muted-foreground">
              {stage}
            </p>
            <p className="text-detail text-muted-foreground">
              Elapsed: {Math.floor(elapsed / 60)}m {elapsed % 60}s. You can close this dialog and keep working. Reopen
              “Set up Subshell here” on this pane to check progress.
            </p>
          </div>
        )}
        {status.isPending && !pending && (
          <p role="status" className="text-detail">
            Checking setup status…
          </p>
        )}
        {status.isError && (
          <div role="alert" className="flex flex-col gap-2">
            <p className="text-destructive text-detail">
              Could not check setup status. Check again before starting another installation.
            </p>
            <Button variant="outline" onClick={() => void status.refetch()}>
              Check status
            </Button>
          </div>
        )}
        {error && !pending && (
          <p role="alert" className="text-destructive text-detail">
            {error}
          </p>
        )}
        {enrolled && (
          <p className="text-detail">
            {enrolled.connected === false
              ? "The machine enrolled, but its connection has not been confirmed. "
              : "The machine enrolled and connected. "}
            <Link
              to="/nodes/$id"
              params={{ id: enrolled.nodeId }}
              className="underline"
              onClick={() => onOpenChange(false)}
            >
              Open its page
            </Link>{" "}
            {enrolled.connected === false
              ? "to check its status. If it stays offline, check the Subshell service on the destination before installing again."
              : "to see what it can launch."}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {pending ? "Continue working" : enrolled ? "Done" : "Cancel"}
          </Button>
          {!enrolled && (
            <Button disabled={pending || status.isPending || status.isError} onClick={() => void upgrade.mutate()}>
              {pending ? "Setting up…" : "Set up Subshell"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
