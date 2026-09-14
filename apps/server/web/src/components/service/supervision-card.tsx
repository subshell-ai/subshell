import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { FactCard } from "@/components/admin-status/fact-list";
import { SupervisionDialog } from "@/components/service/supervision-dialog";
import { Switch } from "@/components/ui/switch";
import type { ServerAutostart } from "@/hooks/use-server-deployment";
import type { SetSupervision } from "@/hooks/use-set-supervision";
import { isDesktop } from "@/lib/desktop";
import { currentMode, loginDisabledReason, modeLabel, type SupervisionMode } from "@/lib/supervision";
import type { ServerDeployment } from "@/types/server-deployment";

export { currentMode, loginDisabledReason, type SupervisionMode };

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
  // The command has returned and the server is coming back. The card cannot
  // move yet — it shows the machine, and the machine has not answered — so
  // this is the state that has to be visible instead of nothing.
  const settling = supervision.settling;

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
    // A second switch while the first is still landing would race it for the
    // port, and `ActionGuard` would refuse it anyway — better not to offer.
    if (mode === current || settling) return;
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
        // one that does not move. Locked while a switch is landing, for the
        // same reason.
        disabled={!desktop || settling !== null}
        onChange={() => ask(mode)}
      />
      {/* `text-label` / `text-detail` rather than the sm/xs pair: this card
          and the desktop assistant's setup screen ask the same question with
          the same words, minutes apart, and they now read at the same size.
          The label is foreground, not muted — it is a line item, not a
          caption. */}
      <span className="space-y-0.5">
        <span className="block font-strong text-label">{title}</span>
        <span className="block text-detail text-muted-foreground">{body}</span>
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
        {/* These two answer WHO runs the server. The switch below answers
            whether it comes back BY ITSELF next time you log in — a different
            question, and one the old copy buried: "keeps it running whether
            or not the app is open" reads as though it already covered
            logins. It does not. Both managers run the server inside your own
            login session, so it stops when you log out either way. */}
        {option("service", "In the background", `${agent} runs it, whether or not Subshell Server is open.`)}
        {option("app", "With the Subshell Server app", "Runs while the app is open; quitting the app stops it.")}
      </div>
      {settling && (
        <p className="col-span-full flex items-center gap-2 text-sm text-warning">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
          <span>Switching to {modeLabel(settling)}… waiting for the server to come back.</span>
        </p>
      )}
      {supervision.timedOut && (
        <p className="col-span-full text-destructive text-sm">
          The server has not come back. Check the Subshell Server app on that machine.
        </p>
      )}
      {current === null && !settling && (
        // Neither radio is checked here, and this says why rather than leaving
        // the card looking like it failed to load. Picking either option is
        // still the way OUT of this state, so nothing is disabled.
        <p className="col-span-full text-detail text-muted-foreground">
          Neither: this server was started by hand, so nothing brings it back when it stops. Choosing an option above
          changes that.
        </p>
      )}
      {!desktop && (
        <p className="col-span-full text-detail text-muted-foreground">
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
          <label htmlFor="server-autostart" className="font-strong text-label">
            Start at login
          </label>
          <p className="text-detail text-muted-foreground">
            {loginBlocked ??
              "Starts the server again the next time you log in to this machine. Without it, the service runs now but nothing brings it back after you log out or restart."}
          </p>
          {autostart.error && <p className="text-destructive text-detail">{autostart.error}</p>}
        </div>
      </div>
    </FactCard>
  );
}
