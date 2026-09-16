import { useState } from "react";
import { RestartDialog } from "@/components/service/restart-dialog";
import { RestartStrip } from "@/components/service/restart-strip";
import { Button } from "@/components/ui/button";
import { useServerDeployment } from "@/hooks/use-server-deployment";
import type { ServerRestart } from "@/hooks/use-server-restart";

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
 * whole single-threaded process. Rendered only when an act says a restart is
 * required, the query exists only in the window where someone is about to
 * act on it — and at 60 s, because nothing it reads changes on its own.
 *
 * The WAITER is injected rather than mounted, because the outage it waits
 * through is not this component's alone to know about: the card folds
 * `outcome === "waiting"` into `busy` so no act can be started against a
 * server that is coming back. One hook, held by the card, read by both.
 */
export function NetworkRestartNotice({
  restart,
  removal = false,
}: {
  /** The card's one restart waiter */
  restart: ServerRestart;
  /**
   * True when the write AWAITING this restart took origins away rather than
   * adding them. "the new address" is a publish's sentence; under an
   * unpublish or a leave there is no new address — what awaits the restart
   * is that a list of old ones stops being accepted. One prop, two
   * sentences, one component, so neither act borrows the other's words.
   */
  removal?: boolean;
}) {
  const { data: view } = useServerDeployment(true, 60_000);
  const [confirming, setConfirming] = useState(false);
  const what = removal ? "the change" : "the new address";

  if (!view) {
    // The fact is the publish's, not the deployment read's, so it is stated
    // before that read lands rather than withheld until it does.
    return <p className="text-detail text-warning">Restart the server to apply {what}.</p>;
  }

  return (
    <div className="space-y-2">
      {/* `text-detail`, and it is load-bearing rather than a taste: this strip
          renders the SAME sentence the `!view` branch above renders, so the two
          sizes meant "Restart the server to apply the new address." sat at 13px
          until `GET /api/admin/server` landed and then re-set at 14px a moment
          after mount. A note about what a control just changed is the design
          system's help text — `detail` at one size — which is also what every
          other amber line on this card uses (`text-detail text-warning` for the
          exposure note and for each publish warning). `AddressesCard` still
          renders its own copy of this strip at `text-sm`; that half is the
          service page's audit, not this component's. */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/50 px-3 py-2 text-detail text-warning">
        <span>
          {view.restart.available
            ? `Restart the server to apply ${what}.`
            : `Saved. ${view.restart.reason ?? "This server cannot restart itself from here."}`}
        </span>
        {/* Gated on the route's own answer: a button that opens a dialog for
            an act the server 409s is worse than no button. */}
        {view.restart.available && (
          <Button
            variant="outline"
            size="sm"
            disabled={restart.outcome === "waiting"}
            onClick={() => setConfirming(true)}
          >
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
