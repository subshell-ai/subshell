import type { SubshellNotifData } from "@/lib/notif-data";

/**
 * The tap/action decision behind a push response, kept pure so the routing
 * rule is testable without the native listener (push-bridge owns the side
 * effects: origin switching, the PATCH, the navigation).
 */

/** The settings tab, spelled like the app spells its group routes (`/(tabs)`). */
export const SETTINGS_HREF = "/(tabs)/settings";

/** What the app should DO about a push, decided from the opaque payload. */
export type PushAction =
  /** Navigate to `href` (after any instance switch push-bridge performs). */
  | { action: "route"; href: string }
  /** The lock-screen Silence bell: one `setNotify(sid, false)` PATCH. */
  | { action: "silence"; sid: string }
  /** Do nothing at all: no navigation, no request. */
  | { action: "ignore" };

export function decidePushAction(data: SubshellNotifData, actionIdentifier?: string): PushAction {
  const silence = actionIdentifier === "silence";
  if (!data.sid) return { action: "ignore" };
  if (silence) return { action: "silence", sid: data.sid };
  return { action: "route", href: `/subshell/${encodeURIComponent(data.sid)}` };
}
