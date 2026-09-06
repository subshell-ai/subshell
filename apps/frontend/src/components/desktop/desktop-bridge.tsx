import { useDesktopBridge } from "@/hooks/use-desktop-bridge";
import { useDesktopNotifications } from "@/hooks/use-desktop-notifications";

/**
 * Mounts the native-chrome action listener.
 *
 * A component rather than a hook call in `Shell` because it must sit INSIDE
 * `QuickAddProvider`: {@link useDesktopBridge} calls `useQuickAdd`, which
 * throws above the provider, and `Shell`'s own body is above it.
 */
export function DesktopBridge() {
  useDesktopBridge();
  useDesktopNotifications();
  return null;
}
