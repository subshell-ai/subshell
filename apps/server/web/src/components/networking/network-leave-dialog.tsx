import { useState } from "react";
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
import { useLeaveNetwork } from "@/hooks/use-network";
import { errMessage } from "@/lib/api";
import type { NetworkRow } from "@/types/network";

/**
 * Disconnecting this machine from a network, behind a typed confirmation.
 *
 * Not the shared yes/no `confirmAction`, for two reasons. The act is not
 * reversible by pressing the same button again — the machine leaves, its
 * addresses stop resolving, and rejoining is a fresh sign-in — and the route
 * takes a `confirm` STRING rather than a flag, so something has to be typed
 * whatever the dialog looks like.
 *
 * What is typed goes to the server VERBATIM and the server decides whether it
 * matches. The dialog never pre-fills it and never compares it locally: a
 * client-side check that disagreed with the server's would refuse a correct
 * answer, and one that agreed would be a second copy of the server's rule.
 */
export function NetworkLeaveDialog({
  row,
  open,
  onOpenChange,
}: {
  /** The network being left */
  row: NetworkRow;
  /** Whether the dialog is showing */
  open: boolean;
  /** Called with the dialog's next open state */
  onOpenChange: (open: boolean) => void;
}) {
  const [typed, setTyped] = useState("");
  const leave = useLeaveNetwork();
  const id = `network-${row.id}-leave-confirm`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        // A dismissed dialog keeps neither the half-typed token nor the last
        // refusal: re-opening it should ask the question fresh.
        if (!next) {
          setTyped("");
          leave.reset();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Disconnect from {row.name}?</DialogTitle>
          <DialogDescription>
            This machine leaves {row.name}. The addresses it answered on there stop working, and anything reaching this
            server through them — a phone, another laptop — loses it until you connect again.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={id}>
            Type <span className="font-mono">{row.id}</span> to confirm
          </Label>
          <Input id={id} value={typed} autoComplete="off" onChange={(event) => setTyped(event.target.value)} />
          {leave.error && <p className="text-destructive text-detail">{errMessage(leave.error, "Nothing changed.")}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="outline"
            className="border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={typed.trim() === "" || leave.isPending}
            onClick={() =>
              leave.mutate(
                { id: row.id, confirm: typed.trim() },
                {
                  onSuccess: () => {
                    setTyped("");
                    onOpenChange(false);
                  },
                },
              )
            }
          >
            {leave.isPending ? "Disconnecting…" : "Disconnect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
