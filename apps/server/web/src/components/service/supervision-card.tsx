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
 * Which mode this machine is in, or `null` when it is in NEITHER.
 *
 * `null` is not a missing answer, it is an answer: a server started by hand —
 * `bun run start`, a container, the e2e stack — is supervised by nothing, and
 * this used to report it as "In the background" on the reasoning that a
 * background service is what an operator would install if they installed
 * anything. That is a fair default for a pending CHOICE and wrong for this
 * control, whose whole documented contract is that it shows the MACHINE. It
 * also put two sentences on one screen that could not both be true: the radio
 * naming a launchd agent that keeps the server running, directly under the
 * Service card's "Running, not supervised".
 *
 * It is the ordinary state of every non-desktop deployment — which is the
 * audience this card was widened for.
 */
export function currentMode(view: ServerDeployment): SupervisionMode | null {
  const service = view.service;
  if (service.manager === "app") return "app";
  // A definition on disk is what "in the background" MEANS here, and it stays
  // the answer while the service is merely stopped. `manager` alone is not
  // enough: it reports what is running now, and an installed-but-stopped
  // service has no running supervisor to name.
  if (service.installed || service.manager === "launchd" || service.manager === "systemd") return "service";
  return null;
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
 * **The act is not the server's to perform, and this is why the switch is a
 * Tauri command rather than a route.** Switching either way needs an actor
 * that outlives the server: going to app mode uninstalls the service, which
 * stops the server, and the thing that must then start it is the desktop app;
 * going back means installing a service while the server this page is served
 * by is the very process holding the port. So the ACT belongs to the desktop
 * app — reached here over the webview's IPC, which survives the server going
 * away — while the CHOICE and its confirmation live on this page.
 *
 * They did not always. This card used to hand the act to the desktop
 * assistant, which opened a window to ask one question; that read as a bug
 * rather than as the trust boundary it was, and the operator's call on
 * 2026-09-12 was to confirm here instead. `docs/security.md` carries the
 * accounting for granting `desktop_set_supervision` to this window.
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
    supervision.reset();
    setConfirming(mode);
  };

  const option = (mode: SupervisionMode, title: string, body: string) => (
    <label className="flex cursor-pointer items-start gap-3">
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
      {/* A `<dl>` takes `<dt>`, `<dd>` and `<div>` — a bare `<label>` is none
          of those — and two radios with no group carry no group NAME, so a
          screen reader announced them as two unrelated controls with no "1 of
          2". One `<div>` fixes both: valid child, named radiogroup. */}
      <div role="radiogroup" aria-label="How this server runs" className="col-span-full space-y-3">
        {option("service", "In the background", `${agent} keeps it running whether or not Subshell Server is open.`)}
        {option("app", "With the Subshell Server app", "Runs while the app is open; quitting the app stops it.")}
      </div>
      {current === null && (
        // Neither radio is checked here, and this says why rather than leaving
        // the card looking like it failed to load. Picking either option is
        // still the way OUT of this state, so nothing is disabled.
        <p className="col-span-full text-muted-foreground text-xs">
          Neither: this server was started by hand, so nothing brings it back when it stops. Choosing an option above
          changes that.
        </p>
      )}
      {!desktop && (
        <p className="col-span-full text-muted-foreground text-xs">
          Changing this is done in the Subshell Server app on that machine.
        </p>
      )}
      <SupervisionDialog
        target={confirming}
        onOpenChange={(open) => {
          // Closable even while pending: the chain runs in the desktop app
          // regardless, and trapping someone in a modal is worse than letting
          // them watch the card instead.
          if (!open) setConfirming(null);
        }}
        view={view}
        pending={supervision.pending}
        error={supervision.error}
        details={supervision.details}
        onConfirm={(withLogin, force) => {
          // No `?? "service"` default: "I do not know which mode you meant" is
          // answered by doing nothing, not by picking one.
          if (!confirming) return;
          void supervision.set(confirming, withLogin, force).then((ok) => {
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
