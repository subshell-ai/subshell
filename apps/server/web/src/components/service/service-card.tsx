import { useState } from "react";
import { FactCard } from "@/components/admin-status/fact-list";
import { RestartDialog } from "@/components/service/restart-dialog";
import { RestartStrip } from "@/components/service/restart-strip";
import { Button } from "@/components/ui/button";
import type { ServerRestart } from "@/hooks/use-server-restart";
import type { ServerDeployment } from "@/types/server-deployment";

/** What the supervisor is CALLED in a sentence; the id `app` is not a name. */
function managerName(manager: ServerDeployment["service"]["manager"]): string {
  return manager === "app" ? "Subshell Server" : (manager ?? "a service manager");
}

/** One line describing who is running this process and since when. */
function _supervisionLine(view: ServerDeployment, bootedAt: string | undefined): string {
  const service = view.service;
  if (!service.supervised) return "Running, not supervised";
  const parts = [`Running under ${managerName(service.manager)}`];
  if (service.pid !== null) parts.push(`as pid ${service.pid}`);
  if (bootedAt) parts.push(`since ${new Date(bootedAt).toLocaleTimeString()}`);
  // No "starts at login" tail: that fact, and the control for it, moved to
  // the supervision card — where it sits under the option it belongs to
  // rather than beside a sentence about this process.
  return parts.join(" ");
}

/** One line describing who is running this process and since when. */
function supervisionLine(view: ServerDeployment, bootedAt: string | undefined): string {
  const service = view.service;
  if (!service.supervised) return "Running, not supervised";
  const parts = [`Running under ${managerName(service.manager)}`];
  if (service.pid !== null) parts.push(`as pid ${service.pid}`);
  if (bootedAt) parts.push(`since ${new Date(bootedAt).toLocaleTimeString()}`);
  const tail = service.manager === "app" ? " · stops when the app quits" : service.enabled ? " · starts at login" : "";
  return `${parts.join(" ")}${tail}`;
}

/**
 * Why the start-at-login switch cannot be used here, or `null` when it can.
 *
 * A pure function because each answer is a real machine state rather than a
 * permission, and every one of them wants a sentence naming what to do
 * instead — a disabled control with no reason is indistinguishable from a
 * broken one. These mirror the route's own three 409s, deliberately: the UI
 * must not offer what the server will refuse.
 */
export function autostartDisabledReason(service: ServerDeployment["service"]): string | null {
  if (service.manager === "app") {
    return "This server runs with the Subshell Server app. To have it back at login, start the app at login instead.";
  }
  if (!service.installed) return "No service is installed on this machine.";
  if (service.enabled === null) return "The service manager did not say whether this server starts at login.";
  return null;
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
