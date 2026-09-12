import { useState } from "react";
import { FactCard } from "@/components/admin-status/fact-list";
import { RestartDialog } from "@/components/service/restart-dialog";
import { RestartStrip } from "@/components/service/restart-strip";
import { Button } from "@/components/ui/button";
import type { ServerRestart } from "@/hooks/use-server-restart";
import type { ServerDeployment } from "@/types/server-deployment";

/** One line describing who is running this process and since when. */
function supervisionLine(view: ServerDeployment, bootedAt: string | undefined): string {
  const service = view.service;
  if (!service.supervised) return "Running, not supervised";
  const parts = [`Running under ${service.manager ?? "a service manager"}`];
  if (service.pid !== null) parts.push(`as pid ${service.pid}`);
  if (bootedAt) parts.push(`since ${new Date(bootedAt).toLocaleTimeString()}`);
  return `${parts.join(" ")}${service.enabled ? " · starts at login" : ""}`;
}

/**
 * Who supervises this server, and the one control that acts on the process
 * itself (spec 2026-09-12 § 4.1).
 *
 * `bootedAt` is a prop rather than a query of this card's own: it comes from
 * `GET /api/admin/status`, which the route already mounts — and has to, since
 * the restart waiter compares against the value that query caches. A second
 * subscription here would poll the same route twice for one sentence.
 */
export function ServiceCard({
  view,
  restart,
  bootedAt,
}: {
  /** The deployment view */
  view: ServerDeployment;
  /** The page's restart handle */
  restart: ServerRestart;
  /** Process start time from `admin/status`, when the page has it */
  bootedAt?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const service = view.service;

  return (
    <FactCard title="Service">
      <p className="col-span-full text-sm">{supervisionLine(view, bootedAt)}</p>
      {!service.supervised && view.restart.reason && (
        <p className="col-span-full text-muted-foreground text-sm">{view.restart.reason}</p>
      )}
      {service.paneSafety !== "keeps" && (
        <p className="col-span-full text-sm text-warning">
          Restarting will close every running subshell; reinstall the service definition to fix this.
        </p>
      )}
      <div className="col-span-full flex items-center gap-3">
        <Button
          variant="outline"
          disabled={!view.restart.available || restart.outcome === "waiting"}
          title={view.restart.available ? undefined : (view.restart.reason ?? undefined)}
          onClick={() => setConfirming(true)}
        >
          Restart server
        </Button>
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
    </FactCard>
  );
}
