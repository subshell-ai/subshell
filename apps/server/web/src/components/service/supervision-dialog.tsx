import { useState } from "react";
import type { SupervisionMode } from "@/components/service/supervision-card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import type { ServerDeployment } from "@/types/server-deployment";

/**
 * What switching to `target` will do, in the order it happens.
 *
 * Exported so the words are testable as data, the way `recovery-model.ts`
 * treats the assistant's. The two lists end on the same fact — running
 * subshells survive either way — because that is the question anyone
 * hesitating over this dialog is actually asking.
 */
export function consequences(target: SupervisionMode, platform: string, autostart: boolean): string[] {
  const agent = platform === "darwin" ? "launchd agent" : "systemd user service";
  if (target === "app") {
    return [
      `Removes the ${agent}`,
      "Starts the server inside Subshell Server",
      "Quitting the app will stop the server",
      "Running subshells keep running",
    ];
  }
  return [
    "Stops the server this app is running",
    `Installs a ${agent} and starts it`,
    autostart ? "Starts it again at every login" : "Does not start it at login",
    "Running subshells keep running",
  ];
}

/**
 * The confirmation in front of changing who runs the server.
 *
 * A dialog on this page rather than a screen in the desktop assistant
 * (operator's call, 2026-09-12). The window that used to open here was the
 * security boundary made visible — the act is privileged and this page is
 * served content — and that boundary is now relaxed for exactly this one
 * command, on the argument in `docs/security.md`: a page that already holds
 * `POST /api/admin/server/restart` can do worse than move the server between
 * two supervisors, and the assistant window read as a bug rather than a
 * safeguard. This dialog is therefore a confirmation for the PERSON, not a
 * defence against the page; the words are its whole job.
 *
 * `pending` is honoured across the whole chain, which can take several
 * seconds — an uninstall, a spawn, a service install — and during which this
 * page loses its server. The button says so instead of going quiet.
 */
export function SupervisionDialog({
  target,
  onOpenChange,
  view,
  pending,
  error,
  onConfirm,
}: {
  /** The mode being switched TO, or null when the dialog is closed */
  target: SupervisionMode | null;
  /** Called with false when the person dismisses */
  onOpenChange: (open: boolean) => void;
  /** The deployment view, for the platform's own words */
  view: ServerDeployment;
  /** True while the switch is running */
  pending: boolean;
  /** Why the last attempt failed, null when it did not */
  error: string | null;
  /** Called with the login answer when the person confirms */
  onConfirm: (autostart: boolean) => void;
}) {
  // Only meaningful when going TO a service; the setup screen's default is
  // the default here too, and the card's own switch changes it afterwards.
  const [autostart, setAutostart] = useState(true);
  const toApp = target === "app";

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{toApp ? "Run the server with the app?" : "Run the server in the background?"}</DialogTitle>
          <DialogDescription>
            {toApp
              ? "The server will live as long as Subshell Server does."
              : "The server will run whether or not Subshell Server is open."}
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-1.5 text-sm">
          {target &&
            consequences(target, view.platform, autostart).map((line) => (
              <li key={line} className="flex gap-2">
                <span aria-hidden className="text-muted-foreground">
                  •
                </span>
                <span>{line}</span>
              </li>
            ))}
        </ul>
        {!toApp && (
          <div className="flex items-center gap-3 text-sm">
            <Switch checked={autostart} onCheckedChange={setAutostart} id="supervision-dialog-autostart" />
            <label htmlFor="supervision-dialog-autostart">Start it at every login</label>
          </div>
        )}
        <p className="text-muted-foreground text-xs">
          This page will lose its connection for a few seconds while the server comes back.
        </p>
        {error && <p className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => onConfirm(autostart)} disabled={pending}>
            {pending ? "Switching…" : toApp ? "Run with the app" : "Run in the background"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
