import type { SessionSharesRepository } from "@/db/repositories/session-shares.repository.js";
import type { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import type { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import type { SessionSharePermission } from "@/db/types/session-shares.db-types.js";
import type { SessionTable } from "@/db/types/sessions.db-types.js";

/**
 * A viewer's effective access to one session (spec 2026-08-31 §4). Viewer-
 * relative: the same session is `owner` to its creator, `edit`/`view` to a
 * grantee, and `none` to everyone else. Admins resolve to `edit` (effective
 * operator access, not ownership) so owner-only acts — delete, managing shares,
 * the notify bell — stay with the real owner.
 */
export type Access = "owner" | "edit" | "view" | "none";

const RANK: Record<Access, number> = { none: 0, view: 1, edit: 2, owner: 3 };

/**
 * Pure resolver — no DB. Given the caller's identity, the session's owner, and
 * its grant rows, returns the highest access that applies.
 *
 * Order (spec §4.2): owner wins outright; else an admin gets `edit`; else the
 * highest of the Everyone grant and any grant naming this viewer; else `none`.
 *
 * @param viewerId - The signed-in user asking
 * @param isAdmin - Whether that user holds the admin role
 * @param ownerUserId - The session's owner
 * @param shares - The session's grant rows (only `granteeUserId`/`permission` read)
 */
export function resolveSessionAccess(
  viewerId: string,
  isAdmin: boolean,
  ownerUserId: string,
  shares: { granteeUserId: string | null; permission: SessionSharePermission }[],
): Access {
  if (viewerId === ownerUserId) return "owner";
  if (isAdmin) return "edit";
  let best: Access = "none";
  for (const s of shares) {
    if (s.granteeUserId !== null && s.granteeUserId !== viewerId) continue;
    if (RANK[s.permission] > RANK[best]) best = s.permission;
  }
  return best;
}

/** True when `have` meets or exceeds `min` (owner > edit > view). */
export function accessAtLeast(have: Access, min: Exclude<Access, "none">): boolean {
  return RANK[have] >= RANK[min];
}

/** The repositories `loadSessionAccess` needs — injected so tests use a scratch DB. */
export interface SessionAccessDeps {
  sessions: SessionsRepository;
  shares: SessionSharesRepository;
  userMeta: UserMetaRepository;
}

/**
 * Loads a session and resolves one viewer's access to it in a single step, so
 * every gate (HTTP, WS, workspace pane) asks the same question the same way.
 *
 * A missing session is NOT an error here — it returns `{ row: undefined,
 * access: "none" }` so the caller can map it to the same 404 as an invisible
 * session (never leaking that the id exists).
 */
export async function loadSessionAccess(
  deps: SessionAccessDeps,
  viewerId: string,
  sessionId: string,
): Promise<{ row: SessionTable | undefined; access: Access }> {
  const row = await deps.sessions.findById(sessionId);
  if (!row) return { row: undefined, access: "none" };
  const isAdmin = (await deps.userMeta.getRole(viewerId)) === "admin";
  const shares = await deps.shares.listForSession(sessionId);
  return { row, access: resolveSessionAccess(viewerId, isAdmin, row.userId, shares) };
}
