import { useState } from "react";
import { RestartDialog } from "@/components/service/restart-dialog";
import { RestartStrip } from "@/components/service/restart-strip";
import { Button } from "@/components/ui/button";
import { useServerDeployment } from "@/hooks/use-server-deployment";
import { useServerRestart } from "@/hooks/use-server-restart";

/**
 * What a publish that rewrote config.env still needs: a restart.
 *
 * Nothing here is new — it is `AddressesCard`'s strip, dialog and waiter,
 * reused rather than re-worded. The cost of restarting (running subshells
 * close on an old service definition; open terminals reconnect either way),
 * the `force` override and the "comes back at…" address are stated once, in
 * `RestartDialog`, and a second copy of that reasoning on this page would be
 * a second thing to keep true.
 *
 * It mounts the deployment read ITSELF rather than taking it as a prop, and
 * that is why it is a component and not a fragment: `GET /api/admin/server` is
 * a `Bun.spawnSync` of `netstat` and the service manager, which stalls the
 * whole single-threaded process. Rendered only after a publish says a restart
 * is required, the query exists only in the window where someone is about to
 * act on it — and at 60 s, because nothing it reads changes on its own.
 */
export function NetworkRestartNotice() {
  const { data: view } = useServerDeployment(true, 60_000);
  const restart = useServerRestart();
  const [confirming, setConfirming] = useState(false);

  if (!view) {
    // The fact is the publish's, not the deployment read's, so it is stated
    // before that read lands rather than withheld until it does.
    return <p className="text-detail text-warning">Restart the server to apply the new address.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/50 px-3 py-2 text-sm text-warning">
        <span>
          {view.restart.available
            ? "Restart the server to apply the new address."
            : `Saved. ${view.restart.reason ?? "This server cannot restart itself from here."}`}
        </span>
        {/* Gated on the route's own answer: a button that opens a dialog for
            an act the server 409s is worse than no button. */}
        {view.restart.available && (
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            Restart
          </Button>
        )}
      </div>
      <RestartStrip view={view} restart={restart} />
      <RestartDialog
        open={confirming}
        onOpenChange={setConfirming}
        view={view}
        onConfirm={(force) => {
          setConfirming(false);
          void restart.restart(force ? { force: true } : {});
        }}
      />
    </div>
  );
}
