import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { FactCard } from "@/components/admin-status/fact-list";
import { CopyableValue } from "@/components/service/copyable-value";
import { RestartDialog, resumeElsewhere } from "@/components/service/restart-dialog";
import { ElsewhereLink, RestartStrip } from "@/components/service/restart-strip";
import { Button } from "@/components/ui/button";
import type { ServerRestart } from "@/hooks/use-server-restart";
import type { ServerDeployment } from "@/types/server-deployment";

/**
 * The command that rewrites this machine's service definition.
 *
 * `service install` writes the unit/plist unconditionally rather than
 * refusing when one is already there, so it is the reinstall — there is no
 * separate verb, and nothing in the dashboard can do it: installing is one of
 * the acts with no HTTP route, because it leaves the server unreachable.
 */
export const REINSTALL_COMMAND = "subshell-server service install";

/** What the supervisor is CALLED in a sentence; the id `app` is not a name. */
function managerName(manager: ServerDeployment["service"]["manager"]): string {
  return manager === "app" ? "Subshell Server" : (manager ?? "a service manager");
}

/**
 * One line describing who is running this process and since when.
 *
 * This line is also what a RESTART speaks through (see the card below): while
 * one is in flight it is REPLACED rather than joined by a second sentence,
 * and when the server returns it re-renders with the new pid and start time —
 * which is the whole confirmation that the restart landed.
 */
function supervisionLine(view: ServerDeployment, bootedAt: string | undefined): string {
  const service = view.service;
  if (!service.supervised) return "Running, not supervised";
  const parts = [`Running under ${managerName(service.manager)}`];
  if (service.pid !== null) parts.push(`as pid ${service.pid}`);
  if (bootedAt) parts.push(`since ${new Date(bootedAt).toLocaleTimeString()}`);
  // No "starts at login" tail, and no "stops when the app quits": both facts
  // — and the control for the first — belong to `SupervisionCard`, where
  // they sit under the option that owns them rather than trailing a sentence
  // about this process.
  return parts.join(" ");
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
  // The restart speaks through the supervision line rather than beside it:
  // "Running under launchd as pid 4242" and "Restarting…" cannot both be true,
  // and shown together they made the page look like it had not noticed its own
  // button. When the wait ends this reverts to the sentence — by then naming
  // the NEW pid and start time, which is the confirmation that it worked.
  const restarting = restart.outcome === "waiting";
  const elsewhere = restarting ? resumeElsewhere(view) : null;

  return (
    <FactCard title="Service">
      <p
        className={restarting ? "col-span-full flex items-center gap-2 text-sm text-warning" : "col-span-full text-sm"}
      >
        {restarting ? (
          <>
            {/* The wait is up to a minute and the page is losing its server
                while it happens, so a static sentence reads as a page that
                has stopped rather than one that is working. */}
            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
            <span>
              Restarting… waiting for the server to come back.
              {elsewhere && <ElsewhereLink href={elsewhere} />}
            </span>
          </>
        ) : (
          supervisionLine(view, bootedAt)
        )}
      </p>
      {!restarting && !service.supervised && view.restart.reason && (
        <p className="col-span-full text-muted-foreground text-sm">{view.restart.reason}</p>
      )}
      {/* **Gated on `installed`.** `paneSafety` is `"unknown"` when there is no
          definition to read, and `"unknown" !== "keeps"`, so this fired on
          every machine with no service at all — telling someone to reinstall a
          definition that does not exist, under a Restart button that is
          disabled anyway because nothing supervises the process. */}
      {service.installed && service.paneSafety !== "keeps" && (
        <div className="col-span-full space-y-1.5 text-sm text-warning">
          <p>
            {service.paneSafety === "kills"
              ? "Restarting will close every running subshell: this machine's service definition predates the setting that spares live panes."
              : "This machine's service definition could not be read, so whether a restart keeps running subshells is unknown."}
          </p>
          {/* The actual act, named. "Reinstall the service definition" is not
              something a person can do — this is. `install` rewrites the
              definition in place, so it IS the reinstall. */}
          <p className="text-detail text-muted-foreground">
            Rewrite it by running <CopyableValue value={REINSTALL_COMMAND} label="Reinstall command" /> on that machine,
            then restart the server.
          </p>
        </div>
      )}
      <div className="col-span-full flex items-center gap-3">
        <Button
          variant="outline"
          disabled={!view.restart.available || restarting}
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
