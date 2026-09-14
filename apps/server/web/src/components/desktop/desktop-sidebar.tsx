import { AppSidebar } from "@/components/app-sidebar";
import { DesktopServerPill } from "@/components/desktop/desktop-server-pill";
import { DragStrip } from "@/components/desktop/drag-strip";
import { desktopPlatform } from "@/lib/desktop";
import { cn } from "@/lib/utils";

/**
 * The rail the desktop shell renders instead of the web one.
 *
 * It is the SAME component. `AppSidebar` is not a list of links — it is the
 * drag source for `application/x-subshell-id`, the live-status surface, the
 * host of two context menus, the quick-add trigger and the only consumer of
 * the collapse preference, all riding one SSE feed. A second rail would lose
 * every one of those silently and then drift, so this changes the chrome and
 * keeps the machine.
 */
export function DesktopSidebar() {
  const macos = desktopPlatform() === "macos";

  return (
    <AppSidebar
      variant="desktop"
      // Room for the traffic lights, which now float over the rail's top strip.
      className={cn(macos && "[&>div:nth-child(2)]:pt-7")}
      headerAbove={macos ? <DragStrip /> : undefined}
      footerEnd={({ collapsed }) => <DesktopServerPill collapsed={collapsed} />}
    />
  );
}
