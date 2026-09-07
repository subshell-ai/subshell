import { useDesktopNotifications } from "@/hooks/use-desktop-notifications";

/**
 * Mounts the native-notification watcher.
 *
 * Separate from `DesktopBridge` because the two want different homes. The
 * action bridge is chrome and should be live everywhere; this reads the live
 * subshell list, so it belongs INSIDE `LiveSubshellsFeedProvider` and behind
 * the same signed-in gate — mounted above them it fires an unauthenticated
 * `/api/subshells` on the login screen and reads a default feed context that
 * never updates.
 */
export function DesktopNotifications() {
  useDesktopNotifications();
  return null;
}
