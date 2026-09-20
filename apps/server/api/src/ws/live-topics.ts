import type { SubshellSharePermission } from "@/db/types/subshell-shares.db-types.js";
import { resolveSubshellAccess } from "@/lib/subshell-access.js";

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

/** Prefix of every per-viewer topic; see {@link userTopic}. */
const USER_TOPIC_PREFIX = "live:u:";

/** The topic carrying rows one specific viewer can see by owning or being granted them. */
export function userTopic(userId: string): string {
  return `${USER_TOPIC_PREFIX}${userId}`;
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

/**
 * What to tell the audience a row USED to have, once its shares changed.
 *
 * **Topics are not a flat set, and treating them as one is a disclosure bug
 * with a live victim.** `EVERYONE_TOPIC` SUBSUMES every user topic — a viewer
 * on `live:u:me` is also on `live:everyone` — so a plain set-difference of
 * "topics before" minus "topics now" names topics whose subscribers still
 * hold the row. Measured before this function existed: sharing your own
 * private subshell with Everyone published `subshell-gone` to your own topic
 * right after the row itself, and the client (whose `goneIds` is sticky for
 * the life of the connection) dropped it until the tab reconnected. Sharing a
 * thing made it vanish.
 *
 * So the difference is taken over REACHABILITY, and the answer has two kinds:
 *
 * - **`gone`** — every subscriber of this topic has certainly lost the row, so
 *   it can be removed at once. True of a user topic when neither it nor
 *   `everyone` survives: that viewer subscribes to those two alone (an admin
 *   subscribes to `admins` alone and is never on a user topic), so nothing
 *   else could still be carrying it to them.
 * - **`recheck`** — the topic MIGHT have lost it, and only a per-viewer
 *   resolve can say. This is `everyone` losing its grant while named topics
 *   survive: the same broadcast reaches the owner, who kept the row, and every
 *   stranger, who did not. Nothing addressable distinguishes them, so the
 *   frame asks rather than asserts and the client's snapshot — which IS
 *   per-viewer — decides.
 *
 * @param revoked - {@link recipientTopics} of the row as it was
 * @param current - {@link recipientTopics} of the row as it now is
 */
export function revocationTopics(revoked: string[], current: string[]): { gone: string[]; recheck: string[] } {
  const kept = new Set(current);
  const everyoneKept = kept.has(EVERYONE_TOPIC);
  const gone: string[] = [];
  const recheck: string[] = [];
  for (const topic of revoked) {
    if (kept.has(topic)) continue;
    // A user topic still reached through the Everyone grant — the viewer kept
    // the row by a wider route than the one that ended.
    if (everyoneKept && topic.startsWith(USER_TOPIC_PREFIX)) continue;
    if (topic === EVERYONE_TOPIC) recheck.push(topic);
    else gone.push(topic);
  }
  return { gone, recheck };
}

/**
 * A principal who is neither the owner nor any named grantee — i.e. someone
 * whose access can only come from the Everyone grant. The NUL keeps it from
 * ever colliding with a real user id.
 */
const STRANGER = "\u0000stranger";

/**
 * Topics whose subscribers KEPT the row but at a different permission level.
 *
 * Reachability is not the whole of a share change. Downgrading a named
 * grantee from `edit` to `view` leaves both topic sets identical, so
 * {@link revocationTopics} has nothing to say — and the row is re-broadcast
 * carrying no `access` at all, because a broadcast reaches every subscriber
 * of a topic. The client therefore keeps the stamp it holds, which is the
 * correct rule and here means it keeps rendering rename, restart and
 * terminal-input affordances it no longer has. Not an escalation — every
 * route re-resolves — but it is the stale-UI failure this design set out to
 * remove, and the role axis was already handled while this one was not.
 *
 * Unlike the topic derivation above, this deliberately calls the CANONICAL
 * `resolveSubshellAccess`: it is a diff of one resolver against itself across
 * time, not a second implementation of it, so there is nothing here for the
 * equivalence test to keep honest.
 *
 * Only a change BETWEEN two levels of real access counts. Gaining access
 * arrives as the row itself; losing it entirely is {@link revocationTopics}.
 *
 * @returns topics that should be asked to re-resolve, never told anything
 */
export function levelChangedTopics(row: { ownerUserId: string; before: ShareRow[]; after: ShareRow[] }): string[] {
  const topics = new Set<string>();
  const named = new Set<string>();
  for (const share of [...row.before, ...row.after]) {
    if (share.granteeUserId !== null && share.granteeUserId !== row.ownerUserId) named.add(share.granteeUserId);
  }
  // The Everyone grant's own level, read through the eyes of someone who has
  // no other route to the row.
  for (const principal of [STRANGER, ...named]) {
    const before = resolveSubshellAccess(principal, false, row.ownerUserId, row.before);
    const after = resolveSubshellAccess(principal, false, row.ownerUserId, row.after);
    if (before === "none" || after === "none" || before === after) continue;
    topics.add(principal === STRANGER ? EVERYONE_TOPIC : userTopic(principal));
  }
  // The owner is always `owner` and an admin always holds instance-wide
  // `edit`, so neither can be changed by a grant edit.
  return [...topics];
}
