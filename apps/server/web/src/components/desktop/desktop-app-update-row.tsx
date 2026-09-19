import { VersionRow } from "@/components/sidebar/version-row";
import { useDesktopAppUpdate } from "@/hooks/use-desktop-app-update";
import { desktopInvoke } from "@/lib/desktop";
import { appUpdateNotice } from "@/lib/desktop-app-update";

/**
 * The footer row naming the APP hosting this page, with a dot when a newer
 * build exists (spec 2026-09-17 §5.3; collapsed to one line 2026-09-18).
 *
 * Two surfaces know an app update exists — the tray item and this row — and
 * this is the one a person lives beside. It shows and never applies: pressing
 * it raises the assistant at `update`, where download, verify, install and
 * restart all live on the bundled page. The row installs nothing, and there is
 * nothing here to abort.
 *
 * **It is one line in both states now.** It used to render a plain `<p>` when
 * nothing was known and a two-line block with an [Update] button and a
 * dismiss × when something was — two shapes for one fact, and the quiet shape
 * was inert, which made the version the last thing in the app a person could
 * read and not act on. Now the line is always a door and the news is a dot.
 *
 * **Absence still means the shell did not answer**, not "up to date": a
 * browser, or a build predating `desktop_app_update`, renders nothing at all,
 * and a `null` notice renders the version alone. Neither is a claim about what
 * the next check will find.
 */
export function DesktopAppUpdateRow({ collapsed }: { collapsed: boolean }) {
  const { data } = useDesktopAppUpdate();
  if (!data) return null;

  // `update`, not the deleted `app-update` (spec 2026-09-18 D3). The two
  // assistant update screens collapsed into ONE act — the app and the server
  // it ships are updated by one press — and the old id now parses to `Home`,
  // so a stale string here raised the assistant at whatever the probe implied
  // instead of the update screen, silently.
  return (
    <VersionRow
      label={`Subshell Server ${data.currentVersion}`}
      notice={appUpdateNotice(data)}
      onActivate={() => void desktopInvoke("desktop_open_assistant", { screen: "update" })}
      // The same words whether or not a dot is showing, because the screen it
      // opens CHECKS either way — the same reason the tray item keeps the
      // "Check for Updates…" label on both of its states.
      actionLabel="Check for updates"
      collapsed={collapsed}
    />
  );
}
