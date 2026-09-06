import { AppSidebar } from "@/components/app-sidebar";
import { DesktopServerPill } from "@/components/desktop/desktop-server-pill";

/**
 * The rail the desktop shell renders instead of the web one.
 *
 * It is the SAME component. `AppSidebar` is not a list of links — it is the
 * drag source for `application/x-subshell-id`, the live-status surface, the
 * host of two context menus, the quick-add trigger and the only consumer of
 * the collapse preference, all riding one SSE feed. A second rail would lose
 * every one of those silently and then drift, so this changes the chrome and
 * keeps the machine.
 *
 * Today that difference is small — a wider rail and a server row in the
 * footer. The window is still decorated: an overlay title bar has to be
 * negotiated with the shell (an old SPA under a chrome-less window is an
 * UNMOVABLE window), so it lands together with the menu bar and tray rather
 * than ahead of them.
 */
export function DesktopSidebar() {
  return <AppSidebar variant="desktop" footerEnd={({ collapsed }) => <DesktopServerPill collapsed={collapsed} />} />;
}
