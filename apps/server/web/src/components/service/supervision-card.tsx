import { useState } from "react";
import { FactCard } from "@/components/admin-status/fact-list";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { ServerAutostart } from "@/hooks/use-server-deployment";
import { desktopInvoke, isDesktop } from "@/lib/desktop";
import type { ServerDeployment } from "@/types/server-deployment";

/** The two answers to "what starts this server", as the page shows them. */
export type SupervisionMode = "service" | "app";

/**
 * Which mode this machine is in, from the deployment view.
 *
 * `manager: "app"` is the only positive signal — every other value, including
 * a machine with no manager at all, is the background answer, because that is
 * what an operator would install if they installed anything.
 */
export function currentMode(view: ServerDeployment): SupervisionMode {
  return view.service.manager === "app" ? "app" : "service";
}

/**
 * Whether the login box is usable, or `null` when it is — with the reason.
 *
 * The three cases mirror `POST /api/admin/server/autostart`'s own 409s: the
 * UI must not offer what the server will refuse. Nested under the background
 * option rather than floating beside it, because "start at login" is a
 * property OF that option and means nothing under the other one.
 */
export function loginDisabledReason(view: ServerDeployment): string | null {
  const service = view.service;
  if (service.manager === "app") return "The app itself would need to start at login.";
  if (!service.installed) return "No service is installed on this machine.";
  if (service.enabled === null) return "The service manager did not say.";
  return null;
}

/**
 * **How this server runs** — the machine's supervision, as against the
 * Service card next to it, which is about the running PROCESS.
 *
 * The two were one card and it read wrong: "Restart server" and "change what
 * supervises this machine from now on" are different kinds of act, and the
 * second arrived as a bare button with an ellipsis that named no alternative.
 *
 * **Both modes are always shown, in every client.** A browser on the LAN and
 * a phone cannot change this — only the app on that machine can — but they
 * can now learn what the machine is doing, which the old card never told
 * them.
 *
 * **The act is not here, and cannot be.** Switching either way needs someone
 * to outlive the server: going to app mode uninstalls the service, which
 * stops the server, and the thing that must then start it is the desktop app;
 * going back means installing a service while the server this page is served
 * by is the very process holding the port. So this card carries the CHOICE
 * and the assistant carries the act — named as a screen, the way the reset
 * card names one.
 */
export function SupervisionCard({
  view,
  autostart,
}: {
  /** The deployment view */
  view: ServerDeployment;
  /** The page's start-at-login handle */
  autostart: ServerAutostart;
}) {
  const current = currentMode(view);
  const [picked, setPicked] = useState<SupervisionMode>(current);
  const loginBlocked = loginDisabledReason(view);
  const desktop = isDesktop();
  // A pick that matches the machine is not a change, and a machine reached
  // from a browser cannot be changed at all.
  const pendingSwitch = desktop && picked !== current;

  const option = (mode: SupervisionMode, title: string, body: string, extra?: React.ReactNode) => (
    <div className="col-span-full">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="radio"
          name="supervision-mode"
          className="mt-1 accent-primary"
          checked={picked === mode}
          // Read-only outside the app: showing the state is the point, and a
          // control that moves but can never be applied is a worse lie than
          // one that does not move.
          disabled={!desktop}
          onChange={() => setPicked(mode)}
        />
        <span className="space-y-0.5">
          <span className="block font-medium text-sm">{title}</span>
          <span className="block text-muted-foreground text-xs">{body}</span>
        </span>
      </label>
      {extra}
    </div>
  );

  return (
    <FactCard title="How this server runs">
      {option(
        "service",
        view.platform === "darwin" ? "In the background (launchd)" : "In the background (systemd)",
        "Runs whether or not Subshell Server is open, and survives a logout only with lingering enabled.",
        <div className="mt-2 ml-7 flex items-start gap-3">
          <Switch
            checked={view.service.enabled === true}
            disabled={loginBlocked !== null || autostart.pending}
            onCheckedChange={(next) => autostart.set(next)}
            aria-label="Start at login"
            id="server-autostart"
          />
          <div className="space-y-0.5">
            <label htmlFor="server-autostart" className="font-medium text-sm">
              Start at login
            </label>
            <p className="text-muted-foreground text-xs">
              {loginBlocked ?? "Brings the server back when you log in to this machine."}
            </p>
            {autostart.error && <p className="text-destructive text-xs">{autostart.error}</p>}
          </div>
        </div>,
      )}
      {option(
        "app",
        "With the Subshell Server app",
        "Runs while the app is open; quitting stops it. Running subshells keep running either way.",
      )}
      {pendingSwitch && (
        <div className="col-span-full">
          {/* The DOOR, and only once a different mode is picked — so it names
              what it will do rather than appearing as a standing verb. The
              assistant confirms this exact mode rather than asking again,
              which is why the screen word carries it. */}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void desktopInvoke("desktop_open_assistant", {
                screen: picked === "app" ? "supervision-app" : "supervision-service",
              })
            }
          >
            {picked === "app" ? "Switch to the app…" : "Switch to a background service…"}
          </Button>
        </div>
      )}
      {!desktop && (
        <p className="col-span-full text-muted-foreground text-xs">
          Changing this is done in the Subshell Server app on that machine.
        </p>
      )}
    </FactCard>
  );
}
