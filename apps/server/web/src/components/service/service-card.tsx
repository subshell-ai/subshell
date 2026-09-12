import { useState } from "react";
import { FactCard } from "@/components/admin-status/fact-list";
import { RestartDialog } from "@/components/service/restart-dialog";
import { RestartStrip } from "@/components/service/restart-strip";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { ServerAutostart } from "@/hooks/use-server-deployment";
import type { ServerRestart } from "@/hooks/use-server-restart";
import { desktopInvoke, isDesktop } from "@/lib/desktop";
import type { ServerDeployment } from "@/types/server-deployment";

/** What the supervisor is CALLED in a sentence; the id `app` is not a name. */
function managerName(manager: ServerDeployment["service"]["manager"]): string {
  return manager === "app" ? "Subshell Server" : (manager ?? "a service manager");
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
  autostart,
  bootedAt,
}: {
  /** The deployment view */
  view: ServerDeployment;
  /** The page's restart handle */
  restart: ServerRestart;
  /** The page's start-at-login handle */
  autostart: ServerAutostart;
  /** Process start time from `admin/status`, when the page has it */
  bootedAt?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const service = view.service;
  const autostartBlocked = autostartDisabledReason(service);

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
      <div className="col-span-full flex items-start gap-3">
        <Switch
          checked={service.enabled === true}
          disabled={autostartBlocked !== null || autostart.pending}
          onCheckedChange={(next) => autostart.set(next)}
          aria-label="Start at login"
          id="server-autostart"
        />
        <div className="space-y-0.5">
          <label htmlFor="server-autostart" className="font-medium text-sm">
            Start at login
          </label>
          <p className="text-muted-foreground text-xs">
            {autostartBlocked ?? "Brings the server back when you log in to this machine."}
          </p>
          {autostart.error && <p className="text-destructive text-xs">{autostart.error}</p>}
        </div>
      </div>
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
      {isDesktop() && (
        <div className="col-span-full">
          {/* The DOOR, not the act. Installing or uninstalling a service
              leaves the server unreachable for a moment, which is the
              standing reason those verbs have no route — so this names a
              SCREEN in the assistant and the person presses Apply there.
              Shown only inside the desktop shell, because in a browser
              there is no assistant to raise. An older desktop build knows
              no such screen and lands on its own home, which is a harmless
              skew rather than an error. */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void desktopInvoke("desktop_open_assistant", { screen: "supervision" })}
          >
            {service.manager === "app" ? "Run as a background service…" : "Run with the app instead…"}
          </Button>
        </div>
      )}
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
