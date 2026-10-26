import type { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import type { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { SubshellSharePermission } from "@/db/types/subshell-shares.db-types.js";
import type { SubshellTable } from "@/db/types/subshells.db-types.js";

/**
 * A viewer's effective access to one subshell (spec 2026-08-31 §4). Viewer-
 * relative: the same subshell is `owner` to its creator, `edit`/`view` to a
 * grantee, and `none` to everyone else — INCLUDING admins: since the operator
 * ruling of 2026-10-09 the admin role carries no subshell reach at all (spec
 * docs/superpowers/specs/2026-10-09-admin-pane-visibility-removal-design.md),
 * so the resolver never reads it and a foreign pane answers "not found" to an
 * admin exactly as to a stranger. Owner-only acts — delete, managing shares,
 * the notify bell — stay with the real owner.
 */
export type Access = "owner" | "edit" | "view" | "none";

const RANK: Record<Access, number> = { none: 0, view: 1, edit: 2, owner: 3 };

/**
 * Pure resolver — no DB. Given the caller's identity, the subshell's owner, and
 * its grant rows, returns the highest access that applies.
 *
 * Order (spec §4.2, as amended 2026-10-09): owner wins outright; else the
 * highest of the Everyone grant and any grant naming this viewer; else `none`.
 * There is no admin arm to place in that order.
 *
 * @param viewerId - The signed-in user asking
 * @param ownerUserId - The subshell's owner
 * @param shares - The subshell's grant rows (only `granteeUserId`/`permission` read)
 */
export function resolveSubshellAccess(
  viewerId: string,
  ownerUserId: string,
  shares: { granteeUserId: string | null; permission: SubshellSharePermission }[],
): Access {
  if (viewerId === ownerUserId) return "owner";
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
}

/**
 * Loads a subshell and resolves one viewer's access to it in a single step, so
 * every gate (HTTP, WS, workspace pane) asks the same question the same way.
 *
 * A missing subshell is NOT an error here — it returns `{ row: undefined,
 * access: "none" }` so the caller can map it to the same 404 as an invisible
 * subshell (never leaking that the id exists).
 *
 * @param opts.allowShares - `true` (default) for a human in a browser: shared
 * grants count. Pass `false` for a machine bearer token — a subshell key may
 * act ONLY on its own owner's subshells (shared or not), never on foreign or
 * shared ones. This keeps the machine path exactly as strict as the
 * pre-sharing owner check. (It used to name the admin boost too; the 2026-10-09
 * ruling removed that arm from the axis, and the option with it.)
 */
export async function loadSubshellAccess(
  deps: SubshellAccessDeps,
  viewerId: string,
  subshellId: string,
  opts: { allowShares?: boolean } = {},
): Promise<{ row: SubshellTable | undefined; access: Access }> {
  const row = await deps.subshells.findById(subshellId);
  if (!row) return { row: undefined, access: "none" };
  const allow = opts.allowShares ?? true;
  const shares = allow ? await deps.shares.listForSubshell(subshellId) : [];
  return { row, access: resolveSubshellAccess(viewerId, row.userId, shares) };
}
