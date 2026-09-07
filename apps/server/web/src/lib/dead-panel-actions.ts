import type { SubshellAccess } from "@/types/subshell";

/**
 * Which lifecycle buttons the terminal's exited (dead) panel may show for the
 * current viewer — the same access contract the actions menu enforces
 * (spec 2026-08-31 §4.1): `edit` interacts and manages (revive), only the
 * `owner` may Close (delete), and a `view` grantee watches only.
 *
 * A missing record keeps both buttons: the mid-view-delete path shows this
 * panel for the row the viewer was just watching, and the backend gates the
 * actual mutation either way.
 *
 * @param access - The viewer's effective access from the subshell record
 * @returns Which of the panel's two action buttons may render
 */
export function deadPanelActions(access: SubshellAccess | undefined): { restart: boolean; close: boolean } {
  if (access === undefined) return { restart: true, close: true };
  return { restart: access !== "view", close: access === "owner" };
}
