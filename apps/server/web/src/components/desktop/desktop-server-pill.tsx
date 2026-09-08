import { Circle } from "lucide-react";
import { useServerOffline } from "@/hooks/use-server-offline";
import { desktopInvoke } from "@/lib/desktop";
import { cn } from "@/lib/utils";

/**
 * The footer row that says whether the thing this window is talking to is
 * still there, and opens the server console.
 *
 * Deliberately derived from state the app already holds —
 * {@link useServerOffline} reads the query cache for a stuck `NetworkError` —
 * rather than polling anything of its own. A desktop app that added a second
 * health poll beside the SSE feed would be paying twice for a fact it already
 * has, and the two would disagree during a restart.
 */
export function DesktopServerPill({ collapsed }: { collapsed: boolean }) {
  const offline = useServerOffline();
  const label = offline ? "Server unreachable" : "Server running";

  return (
    <button
      type="button"
      // `desktopInvoke` resolves null rather than throwing when IPC is
      // unavailable, so this degrades to an inert status row instead of a
      // button that errors.
      onClick={() => void desktopInvoke("desktop_open_console")}
      title={`${label} — open the server console`}
      aria-label={`${label}. Open the server console`}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent/50",
        collapsed && "justify-center px-0",
      )}
    >
      <Circle
        aria-hidden
        className={cn("size-2 shrink-0 fill-current", offline ? "text-destructive" : "text-success")}
      />
      {!collapsed && <span className="truncate text-muted-foreground">{label}</span>}
    </button>
  );
}
