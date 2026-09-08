import type { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import type { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import type { SubshellSharePermission } from "@/db/types/subshell-shares.db-types.js";
import type { SubshellTable } from "@/db/types/subshells.db-types.js";

/**
 * A viewer's effective access to one subshell (spec 2026-08-31 §4). Viewer-
 * relative: the same subshell is `owner` to its creator, `edit`/`view` to a
 * grantee, and `none` to everyone else. Admins resolve to `edit` (effective
 * operator access, not ownership) so owner-only acts — delete, managing shares,
 * the notify bell — stay with the real owner.
 */
export type Access = "owner" | "edit" | "view" | "none";

const RANK: Record<Access, number> = { none: 0, view: 1, edit: 2, owner: 3 };

/**
 * Pure resolver — no DB. Given the caller's identity, the subshell's owner, and
 * its grant rows, returns the highest access that applies.
 *
 * Order (spec §4.2): owner wins outright; else an admin gets `edit`; else the
 * highest of the Everyone grant and any grant naming this viewer; else `none`.
 *
 * @param viewerId - The signed-in user asking
 * @param isAdmin - Whether that user holds the admin role
 * @param ownerUserId - The subshell's owner
 * @param shares - The subshell's grant rows (only `granteeUserId`/`permission` read)
 */
export function resolveSubshellAccess(
  viewerId: string,
  isAdmin: boolean,
  ownerUserId: string,
  shares: { granteeUserId: string | null; permission: SubshellSharePermission }[],
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

/** The repositories `loadSubshellAccess` needs — injected so tests use a scratch DB. */
export interface SubshellAccessDeps {
  subshells: SubshellsRepository;
  shares: SubshellSharesRepository;
  userMeta: UserMetaRepository;
}

/**
 * Loads a subshell and resolves one viewer's access to it in a single step, so
 * every gate (HTTP, WS, workspace pane) asks the same question the same way.
 *
 * A missing subshell is NOT an error here — it returns `{ row: undefined,
 * access: "none" }` so the caller can map it to the same 404 as an invisible
 * subshell (never leaking that the id exists).
 *
 * @param opts.allowAdminAndShares - `true` (default) for a human in a browser:
 * admins get effective edit and shared grants count. Pass `false` for a
 * machine bearer token — a subshell key may act ONLY on its own owner's
 * subshells, never on foreign or shared ones and never via the admin boost. This
 * keeps the machine path exactly as strict as the pre-sharing owner check.
 */
export async function loadSubshellAccess(
  deps: SubshellAccessDeps,
  viewerId: string,
  subshellId: string,
  opts: { allowAdminAndShares?: boolean } = {},
): Promise<{ row: SubshellTable | undefined; access: Access }> {
  const row = await deps.subshells.findById(subshellId);
  if (!row) return { row: undefined, access: "none" };
  const allow = opts.allowAdminAndShares ?? true;
  const isAdmin = allow && (await deps.userMeta.getRole(viewerId)) === "admin";
  const shares = allow ? await deps.shares.listForSubshell(subshellId) : [];
  return { row, access: resolveSubshellAccess(viewerId, isAdmin, row.userId, shares) };
}
