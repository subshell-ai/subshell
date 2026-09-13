import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ServerDeployment } from "@/types/server-deployment";

/**
 * The address this page is looking at, or null where there is no document
 * (a test renderer, a server render). Kept as a function so the dialog reads
 * it at render rather than at module load.
 */
function pageOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin;
}

/**
 * The saved base URL when it is somewhere OTHER than the address in the
 * address bar, else null.
 *
 * That is the case the sentence exists for: this page cannot watch the server
 * come back at an address it is not pointed at, so it says where to look
 * instead of waiting for something that will never arrive here.
 *
 * @param view - the deployment view
 * @returns the base URL to name, or null when it is this same origin
 */
export function resumeElsewhere(view: ServerDeployment): string | null {
  const saved = view.settings.APP_BASE_URL.saved;
  const here = pageOrigin();
  if (!saved || !here) return null;
  try {
    return new URL(saved).origin === here ? null : saved;
  } catch {
    // An unparseable base URL is worth naming rather than hiding.
    return saved;
  }
}

/**
 * The confirmation in front of a self-restart.
 *
 * Two bodies, because the two cases promise opposite things: an ordinary
 * restart keeps the tmux panes alive and reconnects the terminals, while a
 * definition without `KillMode=process`/`AbandonProcessGroup` takes every
 * running subshell down with the process. The second is not refused here —
 * the route refuses it, and this offers the forced path deliberately, because
 * an operator whose service file is wrong still has to be able to restart.
 */
export function RestartDialog({
  open,
  onOpenChange,
  view,
  onConfirm,
}: {
  /** Whether the dialog is showing */
  open: boolean;
  /** Called with the dialog's next open state */
  onOpenChange: (open: boolean) => void;
  /** The deployment view, for the pane-safety and address wording */
  view: ServerDeployment;
  /** Called with `force` when the person confirms */
  onConfirm: (force: boolean) => void;
}) {
  // Gated on `installed` for the reason `ServiceCard` is: `paneSafety` is
  // "unknown" when there is no definition to read, and "unknown" is not
  // "keeps", so a machine with no service warned about a definition that does
  // not exist. App mode reports "keeps" and is unaffected either way.
  const kills = view.service.installed && view.service.paneSafety !== "keeps";
  const elsewhere = resumeElsewhere(view);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Restart the server?</DialogTitle>
          <DialogDescription>
            {kills
              ? "This server's service definition will close every running subshell. Rewrite it by running `subshell-server service install` on this machine, or restart anyway."
              : "Running subshells keep running; open terminals reconnect in a few seconds."}
          </DialogDescription>
        </DialogHeader>
        {elsewhere && (
          <p className="text-muted-foreground text-sm">
            The server will come back at{" "}
            <a href={elsewhere} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
              {elsewhere}
            </a>
            .
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="outline"
            className="border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onConfirm(kills)}
          >
            {kills ? "Restart anyway" : "Restart server"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
