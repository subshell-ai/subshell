import { normalizeLabel } from "@internal/subshell-protocol";

/**
 * Cap on a user's display name, matching a node name's and the instance
 * name's 64.
 *
 * A display name belongs to the same class as those: a label one person
 * chooses that another person's browser renders — it is the `granteeName` on
 * every share row (`services/subshells.service.ts`, `api/nodes/node-view.ts`,
 * both resolving through `UsersRepository.displayNamesByIds`) — and that also
 * reaches audit and log lines. 64 is what the other two chose for exactly
 * that reason: long enough for a real person's name, short enough that a
 * picker row or a log record stays readable.
 */
export const USER_NAME_MAX = 64;

/**
 * A submitted display name, cleaned — or the rule that refused it.
 *
 * `empty` is "nothing printable survived", which is a different answer from
 * "too long" and gets a different message.
 */
export type UserNameResult = { ok: true; name: string } | { ok: false; reason: "empty" | "too_long" };

/**
 * The cleaning every display name gets: control characters replaced,
 * whitespace collapsed, capped at {@link USER_NAME_MAX}.
 *
 * The one implementation is `normalizeLabel` — the CR/LF pair is the
 * load-bearing part, since untouched it forges a second line in a log record.
 * Capping rather than refusing is for the caller that CANNOT refuse: the
 * sign-up hook, where a rejection is a failed first run with no account and
 * no way to make one.
 *
 * @param raw - A submitted name, unsanitized
 * @returns The cleaned name, empty when nothing usable remains
 */
export function normalizeUserName(raw: string): string {
  return normalizeLabel(raw, USER_NAME_MAX);
}

/**
 * The same cleaning, but MEASURED instead of truncated — for the admin create
 * route, where an over-long name is refused rather than silently shortened.
 * An admin is at a form and can fix it; a name quietly cut behind their back
 * surfaces much later as a share row naming somebody slightly wrong.
 *
 * The length is measured AFTER the collapse, so the bound describes what
 * would be stored rather than what was typed.
 *
 * @param raw - A submitted name, unsanitized
 * @returns The cleaned name, or which rule refused it
 */
export function checkUserName(raw: string): UserNameResult {
  // Uncapped on purpose: `normalizeLabel` caps by truncating, which is the
  // one thing this caller must not do — it has to SEE the excess to refuse it.
  const name = normalizeLabel(raw, Number.MAX_SAFE_INTEGER);
  if (name.length === 0) return { ok: false, reason: "empty" };
  if (name.length > USER_NAME_MAX) return { ok: false, reason: "too_long" };
  return { ok: true, name };
}
