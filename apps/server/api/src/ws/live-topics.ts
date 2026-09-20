import type { SubshellSharePermission } from "@/db/types/subshell-shares.db-types.js";

/**
 * Topic every signed-in socket joins.
 *
 * An Everyone share grants every signed-in user, so it publishes HERE rather
 * than expanding into one topic per account — which is what keeps a publish
 * from ever reading the user table.
 */
export const EVERYONE_TOPIC = "live:everyone";

/** Topic every admin's socket joins; admins hold instance-wide `edit`. */
export const ADMINS_TOPIC = "live:admins";

/** The topic carrying rows one specific viewer can see by owning or being granted them. */
export function userTopic(userId: string): string {
  return `live:u:${userId}`;
}

/** Just enough of a share row to route it; mirrors `resolveSubshellAccess`'s own parameter. */
interface ShareRow {
  /** `null` is the Everyone grant. */
  granteeUserId: string | null;
  permission: SubshellSharePermission;
}

/**
 * The topics a socket subscribes to at connect.
 *
 * **The sets are disjoint by construction, so every frame reaches a viewer
 * EXACTLY once.** An admin subscribes to `admins` ALONE — they hold
 * instance-wide `edit`, so that topic already carries every row, and adding
 * their own would deliver a row they own twice (measured: an admin owner
 * received each frame two times before this). Everyone else takes their own
 * topic plus the shared-with-all one, which {@link recipientTopics} keeps from
 * overlapping by never publishing to both.
 *
 * Fixed for the life of the socket: a role change does not retro-subscribe an
 * existing connection, exactly as a role change does not re-authenticate one
 * (`docs/security.md` — the same never-re-checked property `/ws` has). The
 * next connect picks it up.
 */
export function topicsForViewer(viewer: { viewerId: string; isAdmin: boolean }): string[] {
  if (viewer.isAdmin) return [ADMINS_TOPIC];
  return [userTopic(viewer.viewerId), EVERYONE_TOPIC];
}

/**
 * The topics one subshell's changes publish to — the INVERSE of
 * {@link import("@/lib/subshell-access.js").resolveSubshellAccess}, derived
 * from the same three facts it reads.
 *
 * This is the second authorization implementation in the codebase and the only
 * one running row → viewers; everything else runs viewer → row. That is sound
 * only because the two are diffed exhaustively against each other in
 * `__tests__/live-topics.test.ts` — delete that test and this function is an
 * unchecked policy path, which is how a private subshell leaks (spec
 * 2026-09-19 §4.1a/§4.2).
 *
 * Costs one shares read per event and nothing per connected viewer, which is
 * the whole reason the fan-out is topics rather than a per-socket loop.
 *
 * @param row - the subshell's owner and its grant rows
 * @returns distinct topic names; publishing to each reaches exactly the
 *          viewers whose access is not `"none"`
 */
export function recipientTopics(row: { ownerUserId: string; shares: ShareRow[] }): string[] {
  // An Everyone share is visible to every signed-in user, which INCLUDES the
  // owner and every explicit grantee — so `everyone` alone carries all of
  // them, and naming their own topics as well would deliver the frame twice.
  // Admins are still named because they subscribe to `admins` alone.
  if (row.shares.some((share) => share.granteeUserId === null)) {
    return [EVERYONE_TOPIC, ADMINS_TOPIC];
  }
  // A Set because an owner who also appears as an explicit grantee would
  // otherwise be published to twice.
  const topics = new Set<string>([userTopic(row.ownerUserId), ADMINS_TOPIC]);
  for (const share of row.shares) {
    if (share.granteeUserId !== null) topics.add(userTopic(share.granteeUserId));
  }
  return [...topics];
}
