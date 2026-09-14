import { useQuery } from "@tanstack/react-query";
import { desktopInvoke, isServerDesktop } from "@/lib/desktop";
import { DESKTOP_PERMISSIONS_QUERY_KEY } from "@/lib/query-keys";
import { type DesktopPermissions, PERMISSIONS, type Permission } from "@/types/permissions";

/**
 * What the app reports when nothing can answer: a browser, a shell too old to
 * know the command, or a dev build that is not an `.app` bundle.
 *
 * `unavailable` and not `not-determined`, because the two mean different
 * things to every surface below: `not-determined` says macOS will ask at the
 * moment of use, which is a promise this build cannot make.
 */
const NO_ANSWER: DesktopPermissions = { notifications: "unavailable", photos: "unavailable" };

/** Whether an IPC answer is the shape this build expects, field by field. */
function isDesktopPermissions(value: unknown): value is DesktopPermissions {
  if (typeof value !== "object" || value === null) return false;
  const { notifications, photos } = value as Record<string, unknown>;
  return PERMISSIONS.includes(notifications as Permission) && PERMISSIONS.includes(photos as Permission);
}

/**
 * Ask the shell about the app's own permissions, once, outside React.
 *
 * Validated rather than cast: this crosses a version boundary — the page is
 * served by whichever server is running and the shell is whatever the person
 * installed — so an answer from a shell that predates one of these fields must
 * read as "no answer", never as a word no surface here knows how to render.
 *
 * @returns the two states, or {@link NO_ANSWER} outside a shell that can say
 */
export async function fetchDesktopPermissions(): Promise<DesktopPermissions> {
  const raw = await desktopInvoke("desktop_permissions");
  return isDesktopPermissions(raw) ? raw : NO_ANSWER;
}

/**
 * The app's standing with macOS, for the surfaces that explain a missing
 * permission where it is missed (spec 2026-09-14 §5).
 *
 * `enabled` on `isServerDesktop()` and not on `isDesktop()`: the command is
 * granted to Subshell Server's window alone, and these permissions are the
 * SERVER app's own — Subshell Client posts no notifications and attaches no
 * photos, so asking there would be a doomed invoke behind every surface.
 *
 * It does not poll. A permission changes in System Settings, which is a place
 * the person has to walk to — and the Fix… buttons take them through the
 * assistant, whose own probe is what watches for the answer flipping. Thirty
 * seconds is short enough that coming back to this window shows the new state
 * and long enough that mounting three surfaces costs one IPC round trip.
 */
export function useDesktopPermissions() {
  return useQuery({
    queryKey: DESKTOP_PERMISSIONS_QUERY_KEY,
    queryFn: fetchDesktopPermissions,
    enabled: isServerDesktop(),
    staleTime: 30_000,
  });
}
