import type { SubshellAccess } from "@/types/subshell";

/**
 * Which controls a subshell screen shows, derived from the viewer's access
 * (spec 2026-08-31 §4.1). Pure so the rule is testable without a render tree:
 *   - view:  watch only — no actions, live terminal is read-only
 *   - edit:  interact + manage (rename/restart) but not the owner-only bell
 *            or deletion (Close) — spec 2026-09-03 shed notes, pin, terminate
 *   - owner: everything
 */
export interface SubshellActionFlags {
  /** Whether to render the action bar at all. */
  showActions: boolean;
  /** rename / restart available. */
  canEdit: boolean;
  /** the notification bell / delete available (owner-only). */
  isOwner: boolean;
  /** the Live terminal accepts input. */
  canInput: boolean;
}

export function subshellActionFlags(access: SubshellAccess | undefined): SubshellActionFlags {
  // Undefined (still loading) behaves like the most restrictive real state so a
  // control never flashes before the owner-relative access is known.
  const a = access ?? "view";
  const canEdit = a !== "view";
  return { showActions: canEdit, canEdit, isOwner: a === "owner", canInput: canEdit };
}
