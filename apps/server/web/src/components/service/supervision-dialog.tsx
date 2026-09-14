import { LoaderCircle } from "lucide-react";
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
import type { PaneSafety, ServerDeployment } from "@/types/server-deployment";

/**
 * What switching to `target` will do, in the order it happens.
 *
 * Exported so the words are testable as data, the way `recovery-model.ts`
 * treats the assistant's. The two lists end on the same fact — running
 * subshells survive either way — because that is the question anyone
 * hesitating over this dialog is actually asking.
 */
export function consequences(
  target: SupervisionMode,
  platform: string,
  autostart: boolean,
  paneSafety: PaneSafety = "keeps",
): string[] {
  const agent = platform === "darwin" ? "launchd agent" : "systemd user service";
  // **Read, not assumed.** This line said "Running subshells keep running"
  // unconditionally, and on a definition predating `KillMode=process` the
  // opposite was true: removing it takes every live subshell's tmux server
  // with it. A dialog that promises the survival of other people's work and
  // then destroys it is worse than one that says nothing.
  const panes =
    paneSafety === "keeps"
      ? "Running subshells keep running"
      : paneSafety === "kills"
        ? "Every running subshell will be closed"
        : "Whether running subshells survive could not be determined";
  if (target === "app") {
    return [
      `Removes the ${agent}`,
      "Starts the server inside Subshell Server",
      "Quitting the app will stop the server",
      panes,
    ];
  }
  return [
    "Stops the server this app is running",
    `Installs a ${agent} and starts it`,
    autostart
      ? "Starts it again the next time you log in"
      : "Does not come back after you log out — you would start it yourself",
    // Leaving app mode stops a child the app signals by main pid only, so
    // panes always survive that direction.
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
  details,
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
  /** The chain log behind that failure, null when there is none */
  details: string | null;
  /** Called with the login answer and whether to override the pane refusal */
  onConfirm: (autostart: boolean, force: boolean) => void;
}) {
  // Only meaningful when going TO a service; the setup screen's default is
  // the default here too, and the card's own switch changes it afterwards.
  const [autostart, setAutostart] = useState(true);
  const toApp = target === "app";
  // Only the Service→App direction removes a definition, so only that
  // direction can be refused on pane safety.
  const lethal = toApp && view.service.paneSafety !== "keeps";

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
            consequences(target, view.platform, autostart, view.service.paneSafety).map((line) => (
              <li key={line} className="flex gap-2">
                <span aria-hidden className="text-muted-foreground">
                  •
                </span>
                <span className={lethal && line.startsWith("Every running") ? "text-warning" : undefined}>{line}</span>
              </li>
            ))}
        </ul>
        {!toApp && (
          <div className="flex items-center gap-3 text-sm">
            <Switch checked={autostart} onCheckedChange={setAutostart} id="supervision-dialog-autostart" />
            <label htmlFor="supervision-dialog-autostart">Start it again at every login</label>
          </div>
        )}
        {lethal && (
          <p className="text-sm text-warning">
            {view.service.paneSafety === "kills"
              ? "This machine's service definition predates the setting that spares live panes. Running `subshell-server service install` on that machine rewrites it."
              : "This machine's service definition could not be read, so this is the safe assumption."}
          </p>
        )}
        <p className="text-detail text-muted-foreground">
          This page will lose its connection for a few seconds while the server comes back.
        </p>
        {error && (
          <div className="space-y-2">
            <p className="text-destructive text-sm">{error}</p>
            {/* The chain is destructive in order, so a failure at step three
                means steps one and two already happened — and step one of
                App→Service is "stop the server this app was running". The
                one-line refusal cannot say that; the log can. Collapsed,
                because it is a recovery aid rather than the answer. */}
            {details && (
              <details className="text-detail">
                <summary className="cursor-pointer text-muted-foreground">What ran before it stopped</summary>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono">
                  {details}
                </pre>
              </details>
            )}
          </div>
        )}
        <DialogFooter>
          {/* Never disabled. Dismissing this dialog is not cancelling the
              command — the chain runs in the desktop app either way — and a
              person watching "Switching…" with no way out is the failure this
              flow is most likely to produce. */}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {/* Not "Close" — the dialog's own X already carries that name, and
                two buttons with one name in one dialog is a worse answer than
                a longer label. This one says what dismissing actually does. */}
            {pending ? "Continue in the background" : "Cancel"}
          </Button>
          <Button
            variant="outline"
            className={lethal ? "border-destructive text-destructive hover:bg-destructive/10" : undefined}
            onClick={() => onConfirm(autostart, lethal)}
            disabled={pending}
          >
            {pending && <LoaderCircle className="animate-spin" aria-hidden />}
            {pending
              ? "Switching…"
              : lethal
                ? "Close subshells and switch"
                : toApp
                  ? "Run with the app"
                  : "Run in the background"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
