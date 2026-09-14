import { PermissionNotice } from "@/components/desktop/permission-notice";
import { ErrorBanner } from "@/components/error-banner";
import { Button } from "@/components/ui/button";
import { useDesktopNotifications } from "@/hooks/use-desktop-notifications";

/**
 * Mounts the native-notification watcher, and shows the one thing it can
 * report.
 *
 * Separate from `DesktopBridge` because the two want different homes. The
 * action bridge is chrome and should be live everywhere; this reads the live
 * subshell list, so it belongs INSIDE `LiveSubshellsFeedProvider` and behind
 * the same signed-in gate — mounted above them it fires an unauthenticated
 * `/api/subshells` on the login screen and reads a default feed context that
 * never updates.
 *
 * The banner (spec 2026-09-14 §5.1) is raised by a notification that did not
 * happen: macOS is refusing them, so the app has silently stopped saying an
 * agent is waiting. Amber rather than destructive — nothing failed, a choice
 * the person made is having a consequence they were never told about — and
 * once per session, because the watcher fires per idle agent and the standing
 * home for this is Preferences → Notifications.
 */
export function DesktopNotifications() {
  const { blocked, dismiss } = useDesktopNotifications();
  if (!blocked) return null;
  return (
    <ErrorBanner
      tone="warning"
      message={
        <PermissionNotice
          pane="notifications"
          message="macOS is blocking notifications from Subshell Server, so it cannot tell you when an agent is waiting."
        />
      }
      action={
        <Button variant="ghost" size="sm" className="h-6 px-2 text-detail" onClick={dismiss}>
          Dismiss
        </Button>
      }
    />
  );
}
