import { useQuery } from "@tanstack/react-query";
import { desktopInvoke, isServerDesktop } from "@/lib/desktop";
import type { DesktopAppUpdate } from "@/lib/desktop-app-update";
import { DESKTOP_APP_UPDATE_QUERY_KEY } from "@/lib/query-keys";

/** Whether an IPC answer is the shape this build expects, field by field. */
function isDesktopAppUpdate(value: unknown): value is DesktopAppUpdate {
  if (typeof value !== "object" || value === null) return false;
  const { currentVersion, availableVersion } = value as Record<string, unknown>;
  if (typeof currentVersion !== "string" || currentVersion === "") return false;
  return availableVersion === null || availableVersion === undefined || typeof availableVersion === "string";
}

/**
 * Ask the shell about its own app update, once, outside React.
 *
 * `null` — and never a guessed `{ currentVersion: "0.0.0" }` — is what "nothing
 * can answer" means here: a browser, a shell too old to know the command, or an
 * IPC refusal. The row treats that as its own absence, because a version line
 * invented from a failed read is a fact about a machine nothing reported.
 *
 * Validated rather than cast, like `fetchDesktopPermissions`: the page is
 * served by whichever server is running and the shell is whatever the person
 * installed, so an answer from across that version gap must read as "no
 * answer", never as a field some surface here renders as `undefined`.
 *
 * @returns the two versions, or `null` outside a shell that can say
 */
export async function fetchDesktopAppUpdate(): Promise<DesktopAppUpdate | null> {
  const raw = await desktopInvoke("desktop_app_update");
  if (!isDesktopAppUpdate(raw)) return null;
  return { currentVersion: raw.currentVersion, availableVersion: raw.availableVersion ?? null };
}

/**
 * The app's own update, for the footer row that shows it (spec 2026-09-17 §5.3).
 *
 * `enabled` on `isServerDesktop()`: `desktop_app_update` is granted to Subshell
 * Server's window alone, and it is that app's version being reported — asking
 * from Subshell Client would be a doomed invoke about a different product.
 *
 * One invoke per page load, and nothing else. The daily launch check behind it
 * changes the answer at most once a day, the tray is the live surface between
 * loads, and a row that polled would be the second thing on this window
 * hammering a command whose whole job is to be asked occasionally.
 */
export function useDesktopAppUpdate() {
  return useQuery({
    queryKey: DESKTOP_APP_UPDATE_QUERY_KEY,
    queryFn: fetchDesktopAppUpdate,
    enabled: isServerDesktop(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
