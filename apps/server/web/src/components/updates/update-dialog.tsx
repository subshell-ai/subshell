import { REINSTALL_COMMAND } from "@/components/service/service-card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ServerUpdateView } from "@/types/updates";

/**
 * The confirmation in front of a server update.
 *
 * It is `restart-dialog.tsx`'s shape, with the backup sentence in front of it,
 * because an update IS a restart with a file swap before it — and it inherits
 * the restart's two bodies for the same reason: an ordinary restart keeps the
 * tmux panes alive and reconnects the terminals, while a definition without
 * `KillMode=process`/`AbandonProcessGroup` takes every running subshell down
 * with the process. The second is not refused HERE — the route refuses it, and
 * this offers the forced path deliberately, because an operator whose service
 * file is wrong still has to be able to update.
 *
 * The backup sentence is not decoration: it is the whole reason this act is
 * reversible, and it names the directory so an operator can find the file
 * before they need it rather than after.
 */
export function UpdateDialog({
  open,
  onOpenChange,
  view,
  onConfirm,
}: {
  /** Whether the dialog is showing */
  open: boolean;
  /** Called with the dialog's next open state */
  onOpenChange: (open: boolean) => void;
  /** The server update view, for the version, the backup and the pane wording */
  view: ServerUpdateView;
  /** Called with `force` when the person confirms */
  onConfirm: (force: boolean) => void;
}) {
  // `paneSafety` is "unknown" when there is no definition to read, and
  // "unknown" is not "keeps" — the same gate `RestartDialog` applies, so a
  // machine whose definition could not be read is warned rather than promised.
  const kills = view.paneSafety !== "keeps";
  const to = view.latest?.version ?? "the newest release";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Update to {to}?</DialogTitle>
          <DialogDescription>
            {kills
              ? `This server's service definition will close every running subshell when it restarts. Rewrite it by running ${REINSTALL_COMMAND} on this machine, or update anyway.`
              : "The server restarts when the new binary is in place; open subshells keep running."}
          </DialogDescription>
        </DialogHeader>
        <p className="text-detail text-muted-foreground">
          The database is backed up to <span className="break-all font-mono">{view.backups.dir}</span> first
          {view.backups.keep === 0 ? " (all kept)" : ` (${view.backups.keep} kept)`}. If the new version cannot start,
          it puts {view.current} and that backup back by itself.
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="outline"
            className={
              kills ? "border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive" : undefined
            }
            onClick={() => onConfirm(kills)}
          >
            {kills ? "Update anyway" : `Update to ${to}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
