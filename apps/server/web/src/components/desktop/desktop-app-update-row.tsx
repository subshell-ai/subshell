import { useNavigate } from "@tanstack/react-router";
import { VersionRow } from "@/components/sidebar/version-row";
import { useDesktopAppUpdate } from "@/hooks/use-desktop-app-update";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { appUpdateNotice } from "@/lib/desktop-app-update";

/**
 * The footer row naming the APP hosting this page, with a dot when a newer
 * build exists (spec 2026-09-17 §5.3; one line since 2026-09-18).
 *
 * Two surfaces know an app update exists — the tray item and this row — and
 * this is the one a person lives beside. It shows and never applies.
 *
 * **It goes to the Updates page, not the assistant** (operator's call,
 * 2026-09-18). It used to raise the bundled window through
 * `desktop_open_assistant({ screen: "update" })`. The page is the better
 * destination from a row that sits inside a signed-in dashboard: inside this
 * app it FOLDS the app row and the Server row into one (spec 2026-09-18 D4),
 * because this bundle ships the server it would install, so it answers both
 * halves — and its control still opens the assistant, which remains the only
 * surface allowed to install either. Nothing is lost; a step is added in front
 * of the destructive part, and the row now behaves identically to the browser's.
 *
 * The TRAY is unaffected and must stay that way: it raises the assistant
 * directly, because it has to work with no session at all, and this page does
 * not exist then.
 *
 * **Admin-gated, because the page is.** `/settings/updates` is one of the nine
 * admin routes, so a member pressing this would land on a page that does not
 * render for them. An inert line is the right answer for someone who cannot
 * act — the same rule `ServerVersionRow` follows, and the reason both rows
 * take the press as optional.
 *
 * **Absence still means the shell did not answer**, not "up to date": a
 * browser, or a build predating `desktop_app_update`, renders nothing at all,
 * and a `null` notice renders the version with no dot. Neither is a claim
 * about what the next check will find.
 */
export function DesktopAppUpdateRow({ collapsed }: { collapsed: boolean }) {
  const { data } = useDesktopAppUpdate();
  const { data: settings } = usePublicSettings();
  const navigate = useNavigate();
  // `=== true`, never truthiness: `undefined` is the read still in flight, and
  // treating that as admin offers a press that lands nowhere.
  const isAdmin = settings?.viewerIsAdmin === true;

  if (!data) return null;

  return (
    <VersionRow
      label={`Subshell Server ${data.currentVersion}`}
      notice={appUpdateNotice(data)}
      onActivate={isAdmin ? () => void navigate({ to: "/settings/updates" }) : undefined}
      actionLabel="Open updates"
      collapsed={collapsed}
    />
  );
}
