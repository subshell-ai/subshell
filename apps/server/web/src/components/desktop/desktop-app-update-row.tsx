import { ArrowUpCircle, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useDesktopAppUpdate } from "@/hooks/use-desktop-app-update";
import { desktopInvoke } from "@/lib/desktop";
import { appUpdateRowVisible, readDismissedAppUpdate, rememberAppUpdateDismissal } from "@/lib/desktop-app-update";

/**
 * The footer row that says the APP hosting this page has a newer build (spec
 * 2026-09-17 §5.3).
 *
 * Two surfaces know an app update exists — the tray item and this row — and
 * this is the one a person actually lives beside. It shows and never applies:
 * [Update] raises the assistant at `app-update`, where download, verify,
 * install and restart all live on the bundled page. The row installs nothing,
 * and there is nothing here to abort.
 *
 * Absence is the normal state, in three directions at once: no answer (browser,
 * or a shell predating the command) renders nothing; an answer with no known
 * update renders the version line with no affordance, because "no update
 * known" is not "up to date"; and a dismissal hides the row for the app run,
 * re-showing the moment the daily check finds a NEWER version — the dismissal
 * is keyed to the version it dismissed, not to a clock.
 */
export function DesktopAppUpdateRow({ collapsed }: { collapsed: boolean }) {
  const { data } = useDesktopAppUpdate();
  // Read once: the dismissal is session-scoped and nothing else writes it, so
  // re-reading per render buys nothing and a state change is the only thing
  // that can make the answer move.
  const [dismissed, setDismissed] = useState<string | null>(readDismissedAppUpdate);

  if (!data) return null;
  const available = data.availableVersion;
  // `update`, not the deleted `app-update` (spec 2026-09-18 D3). The two
  // assistant update screens collapsed into ONE act — the app and the server
  // it ships are updated by one press — and the old id now parses to `Home`,
  // so a stale string here raised the assistant at whatever the probe implied
  // instead of the update screen, silently.
  const openAssistant = () => void desktopInvoke("desktop_open_assistant", { screen: "update" });
  if (available === null) {
    // Nothing to offer, so the row says only which app this is — and in a
    // 56px rail there is no room to say even that, so it says nothing.
    if (collapsed) return null;
    // **It is still a DOOR** (operator's call, 2026-09-18). This branch means
    // "no update known", which is not "up to date" — the daily check may not
    // have run today, or may not have answered — so a line that could only be
    // read was the last place in the app where knowing that led nowhere. The
    // screen it opens does the checking itself, exactly as the tray item's
    // "Check for Updates…" label now does, so one press answers the question
    // the version number raises.
    //
    // No [Update] button and no ×: there is nothing to apply and nothing to
    // dismiss. The affordance is the row, which is why the accessible name
    // says what pressing it does rather than repeating the version.
    return (
      <button
        type="button"
        onClick={openAssistant}
        title={`Subshell Server ${data.currentVersion} — check for updates`}
        aria-label={`Subshell Server ${data.currentVersion}. Check for updates.`}
        className="flex w-full cursor-pointer items-center rounded-md px-2 py-1.5 text-detail text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
      >
        <span className="truncate">Subshell Server {data.currentVersion}</span>
      </button>
    );
  }
  if (!appUpdateRowVisible(data, dismissed)) return null;

  const dismiss = () => {
    rememberAppUpdateDismissal(available);
    setDismissed(available);
  };

  // Collapsed: the update IS the row, one icon like every sibling — the two
  // controls do not fit side by side at this width, and the quieter half of the
  // pair is the one an expansion is a step away from.
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={openAssistant}
        title={`Subshell Server ${data.currentVersion} — v${available} available`}
        aria-label={`Update Subshell Server — v${available} available`}
        className="flex w-full cursor-pointer items-center justify-center rounded-md py-1.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
      >
        <ArrowUpCircle className="h-4 w-4 shrink-0 -translate-y-px" />
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
      {/* The line-item grammar: `label` over `detail`, differing by weight AND
          colour. The version the person runs is the title; the version they
          could run is the metadata beside it. */}
      <div className="min-w-0 flex-1">
        <p className="truncate font-strong text-label">Subshell Server {data.currentVersion}</p>
        <p className="truncate text-detail text-muted-foreground">v{available} available</p>
      </div>
      <Button size="sm" onClick={openAssistant}>
        Update
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={dismiss}
        aria-label="Dismiss update notice"
        title="Dismiss until a newer version"
        className="shrink-0 text-muted-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
