import { useState } from "react";
import { FactCard } from "@/components/admin-status/fact-list";
import { SupervisionDialog } from "@/components/service/supervision-dialog";
import { Switch } from "@/components/ui/switch";
import type { ServerAutostart } from "@/hooks/use-server-deployment";
import type { SetSupervision } from "@/hooks/use-set-supervision";
import { isDesktop } from "@/lib/desktop";
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
 * UI must not offer what the server will refuse.
 *
 * The switch sits BELOW both mode options, not nested under one. It was
 * nested, and that expressed a true dependency in the wrong medium: the
 * indentation wedged a control between the two radios so they stopped
 * reading as a pair, while claiming the toggle belonged to one option when
 * what is true is that "does this come back at login?" is a question about
 * the machine that only one mode can honour today. So the layout is the one
 * every settings pane uses — pick the mode, then its settings — and the
 * dependency is carried the way this codebase carries every other one: a
 * disabled control that says why, and names what would answer instead.
 */
export function loginDisabledReason(view: ServerDeployment): string | null {
  const service = view.service;
  if (service.manager === "app") {
    // Not "unavailable" — the question is real in this mode too, it just has
    // a different answer, and that answer is actionable by the person.
    return "The server starts when the app does. To have it back at login, open Subshell Server at login.";
  }
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
  supervision,
}: {
  /** The deployment view */
  view: ServerDeployment;
  /** The page's start-at-login handle */
  autostart: ServerAutostart;
  /** The page's mode-switch handle */
  supervision: SetSupervision;
}) {
  const current = currentMode(view);
  const loginBlocked = loginDisabledReason(view);
  const desktop = isDesktop();
  const [confirming, setConfirming] = useState<SupervisionMode | null>(null);

  /**
   * Ask for the other mode.
   *
   * **The radio IS the choice**; there is no second button confirming what
   * you just selected. Clicking the unselected mode opens the confirmation
   * dialog on THIS page — the desktop assistant used to open a window for it,
   * and a window popping up to ask one question read as a bug rather than a
   * safeguard (operator's call, 2026-09-12; the security accounting is in
   * `docs/security.md`).
   *
   * **And the radio shows the MACHINE, not a pending choice.** The selection
   * does not move until the next poll reports the change, so dismissing the
   * dialog cannot leave the card claiming a mode that never took effect — the
   * same rule as the login switch beside it, which reflects the server's
   * answer rather than the press.
   */
  const ask = (mode: SupervisionMode) => {
    if (mode === current) return;
    setConfirming(mode);
  };

  const option = (mode: SupervisionMode, title: string, body: string) => (
    <label className="col-span-full flex cursor-pointer items-start gap-3">
      <input
        type="radio"
        name="supervision-mode"
        className="mt-1 accent-primary"
        checked={current === mode}
        // Read-only outside the app: showing the state is the point, and a
        // control that moves but can never be applied is a worse lie than
        // one that does not move.
        disabled={!desktop}
        onChange={() => ask(mode)}
      />
      <span className="space-y-0.5">
        <span className="block font-medium text-sm">{title}</span>
        <span className="block text-muted-foreground text-xs">{body}</span>
      </span>
    </label>
  );

  // The manager's name goes in the SENTENCE, where it explains something,
  // rather than in the title as a parenthetical that explains nothing.
  const agent = view.platform === "darwin" ? "A launchd agent" : "A systemd user service";

  return (
    <FactCard title="How this server runs">
      {option("service", "In the background", `${agent} keeps it running whether or not Subshell Server is open.`)}
      {option("app", "With the Subshell Server app", "Runs while the app is open; quitting the app stops it.")}
      {!desktop && (
        <p className="col-span-full text-muted-foreground text-xs">
          Changing this is done in the Subshell Server app on that machine.
        </p>
      )}
      <SupervisionDialog
        target={confirming}
        onOpenChange={(open) => {
          if (!open && !supervision.pending) setConfirming(null);
        }}
        view={view}
        pending={supervision.pending}
        error={supervision.error}
        onConfirm={(withLogin) => {
          void supervision.set(confirming ?? "service", withLogin).then((ok) => {
            // Stay open on failure, where the reason has just been rendered.
            if (ok) setConfirming(null);
          });
        }}
      />
      {/* The setting FOR the chosen mode, below the choice — a settings pane's
          own shape. Its disabled reason is how the dependency on the mode
          above is expressed, not indentation. */}
      <div className="col-span-full mt-1 flex items-start gap-3 border-t pt-4">
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
      </div>
    </FactCard>
  );
}
