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

/**
 * `grant_approval` pushes name the grant REQUEST uuid in `sid`, not a pane:
 * their tap lands on the settings tab (the real surface) and their silence
 * action is ignored (there is no subshell bell to PATCH). Every other kind
 * behaves exactly as it always has: tap to `/subshell/<sid>`, silence to the
 * PATCH (PR 338 review, Important 1).
 * @param data - The opaque payload (sid + kind + origin)
 * @param actionIdentifier - The response's action id; only "silence" acts
 */
export function decidePushAction(data: SubshellNotifData, actionIdentifier?: string): PushAction {
  const silence = actionIdentifier === "silence";
  if (data.kind === "grant_approval") {
    return silence ? { action: "ignore" } : { action: "route", href: SETTINGS_HREF };
  }
  if (!data.sid) return { action: "ignore" };
  if (silence) return { action: "silence", sid: data.sid };
  return { action: "route", href: `/subshell/${encodeURIComponent(data.sid)}` };
}
