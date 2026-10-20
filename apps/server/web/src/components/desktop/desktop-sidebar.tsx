import { cn } from "@internal/node-admin";
import { AppSidebar } from "@/components/app-sidebar";
import { DesktopAppUpdateRow } from "@/components/desktop/desktop-app-update-row";
import { DesktopServerPill } from "@/components/desktop/desktop-server-pill";
import { DragStrip } from "@/components/desktop/drag-strip";
import { desktopPlatform } from "@/lib/desktop";

/**
 * The rail the desktop shell renders instead of the web one.
 *
 * It is the SAME component. `AppSidebar` is not a list of links — it is the
 * drag source for `application/x-subshell-id`, the live-status surface, the
 * host of two context menus and the quick-add trigger, all riding one live
 * socket. A second panel would lose every one of those silently and then
 * drift, so this changes the chrome and keeps the machine.
 *
 * The footer's two rows ride `footerEnd`, which is also where "only Subshell
 * Server" comes from: `__root.tsx` renders this panel on `isServerDesktop()`, so
 * a row mounted here cannot appear in Subshell Client's window or a browser —
 * and both rows below describe this app, which the client window has no
 * authority to speak about.
 */
export function DesktopSidebar() {
  const macos = desktopPlatform() === "macos";

  return (
    <AppSidebar
      variant="desktop"
      // Room for the traffic lights, which now float over the panel's top strip.
      className={cn(macos && "[&>div:nth-child(2)]:pt-7")}
      headerAbove={macos ? <DragStrip /> : undefined}
      footerEnd={() => (
        <>
          {/* The rows still take a `collapsed` flag; the panel is always
              expanded now, so they always render in full. */}
          <DesktopServerPill collapsed={false} />
          <DesktopAppUpdateRow collapsed={false} />
        </>
      )}
    />
  );
}
