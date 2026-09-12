import { useNavigate } from "@tanstack/react-router";
import { Circle } from "lucide-react";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useServerOffline } from "@/hooks/use-server-offline";
import { desktopInvoke } from "@/lib/desktop";
import { cn } from "@/lib/utils";

/**
 * The footer row that says whether the thing this window is talking to is
 * still there, and leads somewhere useful about it.
 *
 * Deliberately derived from state the app already holds —
 * {@link useServerOffline} reads the query cache for a stuck `NetworkError` —
 * rather than polling anything of its own. A desktop app that added a second
 * health poll beside the SSE feed would be paying twice for a fact it already
 * has, and the two would disagree during a restart.
 *
 * Where it leads depends on both halves of the situation (spec 2026-09-12
 * § 4.6). Unreachable: the native recovery assistant, which is the only
 * surface that can start a server that is not running. Reachable, and the
 * viewer is an admin: the Service page, which is where everything the console
 * used to offer now lives. Reachable and NOT an admin: nowhere — so the row
 * renders as a plain status line rather than a button that refuses.
 */
export function DesktopServerPill({ collapsed }: { collapsed: boolean }) {
  const offline = useServerOffline();
  const navigate = useNavigate();
  const { data: settings } = usePublicSettings();
  const isAdmin = settings?.viewerIsAdmin === true;
  const label = offline ? "Server unreachable" : "Server running";
  const destination = offline ? "open the recovery assistant" : "open Service settings";

  const body = (
    <>
      <Circle
        aria-hidden
        className={cn("size-2 shrink-0 fill-current", offline ? "text-destructive" : "text-success")}
      />
      {/* Kept in the DOM when collapsed rather than dropped: it is the
          accessible name of the whole row, button or not. */}
      <span className={cn("truncate text-muted-foreground", collapsed && "sr-only")}>{label}</span>
    </>
  );

  const shared = cn(
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs",
    collapsed && "justify-center px-0",
  );

  if (!offline && !isAdmin) {
    return (
      <div className={shared} title={label}>
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      // `desktopInvoke` resolves null rather than throwing when IPC is
      // unavailable, so this degrades to an inert status row instead of a
      // button that errors.
      onClick={() => {
        if (offline) void desktopInvoke("desktop_open_assistant");
        else void navigate({ to: "/settings/service" });
      }}
      title={`${label}: ${destination}`}
      aria-label={`${label}. ${destination.charAt(0).toUpperCase()}${destination.slice(1)}`}
      className={cn(shared, "cursor-pointer transition-colors hover:bg-accent/50")}
    >
      {body}
    </button>
  );
}
