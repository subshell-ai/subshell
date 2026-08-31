import type { SessionAccess } from "@/types/session";

/**
 * Which controls a session screen shows, derived from the viewer's access
 * (spec 2026-08-31 §4.1). Pure so the rule is testable without a render tree:
 *   - view:  watch only — no actions, live terminal is read-only
 *   - edit:  interact + manage (rename/notes/restart/terminate) but not the
 *            owner-only bell or deletion
 *   - owner: everything
 */
export interface SessionActionFlags {
  /** Whether to render the action bar at all. */
  showActions: boolean;
  /** rename / notes / restart / terminate available. */
  canEdit: boolean;
  /** the notification bell / delete available (owner-only). */
  isOwner: boolean;
  /** the Live terminal accepts input. */
  canInput: boolean;
}

export function sessionActionFlags(access: SessionAccess | undefined): SessionActionFlags {
  // Undefined (still loading) behaves like the most restrictive real state so a
  // control never flashes before the owner-relative access is known.
  const a = access ?? "view";
  const canEdit = a !== "view";
  return { showActions: canEdit, canEdit, isOwner: a === "owner", canInput: canEdit };
}
