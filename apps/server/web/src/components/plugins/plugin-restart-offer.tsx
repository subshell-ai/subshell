import { Button } from "@internal/node-admin";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { RestartDialog } from "@/components/service/restart-dialog";
import type { ServerRestart } from "@/hooks/use-server-restart";
import type { ServerDeployment } from "@/types/server-deployment";

/**
 * The restart that makes an updated plugin's code the code that actually runs.
 *
 * Replacing the bytes in the store does not replace what this process imported
 * at boot, so an updated row reports `restartRequired` until the server has
 * restarted — and the rows reappearing without that flag is the confirmation,
 * not a banner. (`RestartStrip` deliberately dropped its "Back." line for the
 * same reason: the page already says the news by re-rendering.)
 *
 * The confirmation is `RestartDialog`, not a copy: it owns the pane-safety
 * warning and forwards `force` when the definition would take running panes
 * down. When this machine cannot restart itself, the offer names the command
 * instead of showing a button the route would refuse.
 */
export function PluginRestartOffer({
  restartRequired,
  deployment,
  restart,
}: {
  /** True while an installed plugin wants the process to pick up new bytes */
  restartRequired: boolean;
  /**
   * The deployment view, absent while it is still loading. Absent renders
   * nothing: the update result is already in the rows, and a sentence guessing
   * at this machine's restart answer would be a claim nobody has made.
   */
  deployment?: ServerDeployment;
  /** The page's restart handle */
  restart: ServerRestart;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!restartRequired) return null;

  if (restart.outcome === "waiting") {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-warning">
        {/* The wait is up to a minute and the server is unreachable while it
            happens, so a static sentence would read as a page that stopped. */}
        <LoaderCircle className="h-4 w-4 shrink-0 motion-safe:animate-spin" aria-hidden />
        <span>Restarting… waiting for the server to come back.</span>
      </p>
    );
  }

  if (restart.error) {
    return <p className="text-destructive text-detail">{restart.error}</p>;
  }

  if (restart.outcome === "timeout") {
    return (
      <p className="text-destructive text-detail">
        The server has not come back. Check the service on the machine running it.
      </p>
    );
  }

  if (!deployment) return null;

  if (!deployment.restart.available) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <span>
          Updated plugins take effect after the server restarts, but this server can’t restart itself
          {deployment.restart.reason ? `: ${deployment.restart.reason}` : ""}. Run{" "}
          <code className="font-mono">subshell-server service restart</code> on the machine running it.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
      <span>Updated plugins take effect after the server restarts.</span>
      <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
        Restart server
      </Button>
      <RestartDialog
        open={confirming}
        onOpenChange={setConfirming}
        view={deployment}
        onConfirm={(force) => {
          setConfirming(false);
          void restart.restart(force ? { force: true } : {});
        }}
      />
    </div>
  );
}
