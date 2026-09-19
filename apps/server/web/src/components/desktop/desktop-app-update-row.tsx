import { useNavigate } from "@tanstack/react-router";
import { VersionRow } from "@/components/sidebar/version-row";
import { useDesktopAppUpdate } from "@/hooks/use-desktop-app-update";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { desktopInvoke } from "@/lib/desktop";
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
 * **A member goes to the ASSISTANT instead** (review, 2026-09-19).
 * `/settings/updates` is one of the nine admin routes, so sending a member
 * there lands them on a page that does not render — but making the row inert
 * for them took away the only in-page route they had to the app update, which
 * the assistant has always been happy to give anyone. So the destination
 * follows what the person can actually reach: the page for an admin, the
 * bundled window for everyone else. Both end at the same act; only an admin
 * gets the table with the Server row folded in beside it.
 *
 * This is the one place the two version rows differ on that question.
 * `ServerVersionRow` really is inert for a member, and correctly: a SERVER
 * update is admin-only wherever you stand, while replacing THIS app is not.
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
  // treating that as admin offers a press that lands on a route that will not
  // render. Falling to the assistant while it is unknown costs nothing — that
  // window opens for anyone.
  const isAdmin = settings?.viewerIsAdmin === true;

  if (!data) return null;

  return (
    <VersionRow
      // **"app"**, because this is the BUNDLE's version and not the server's
      // (review, 2026-09-19). It comes from `package_info()` in Rust, while
      // `ServerVersionRow` renders `serverVersion` from public settings — and
      // on a machine whose managed server was updated separately the two are
      // different numbers. Two rows saying `Subshell Server <x>` for two
      // different facts is precisely what the "a version nobody can see is a
      // version nobody quotes in a bug report" argument was against.
      label={`Subshell Server app ${data.currentVersion}`}
      notice={appUpdateNotice(data)}
      onActivate={
        isAdmin
          ? () => void navigate({ to: "/settings/updates" })
          : () => void desktopInvoke("desktop_open_assistant", { screen: "update" })
      }
      actionLabel={isAdmin ? "Open updates" : "Check for updates"}
      collapsed={collapsed}
    />
  );
}
