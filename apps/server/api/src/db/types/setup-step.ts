/**
 * Where the first-run wizard left off, per user (spec 2026-09-16).
 *
 * A **bookmark, not a gate**: nothing about what a person may do depends on
 * it, and the only thing that acts on it is a redirect. `null` — the absent
 * value everywhere, including a stored string this build does not recognise —
 * means "no wizard in progress", which is the state of every account but the
 * first one.
 *
 * There is deliberately no `account` member: the wizard's first screen creates
 * the account, so the earliest a bookmark can exist is the screen AFTER it.
 */
export type SetupStep = "network" | "agent" | "launch";

/** Every step, for validation and for the route's schema. */
export const SETUP_STEPS: readonly SetupStep[] = ["network", "agent", "launch"];

/**
 * The step a brand-new first account is bookmarked on — the screen right after
 * the one that created it. Named here rather than spelled in
 * `promoteFirstUserAtomically`'s SQL so the enum and the statement that writes
 * into it cannot drift.
 */
export const FIRST_SETUP_STEP: SetupStep = "network";

/**
 * Narrows a stored column value to a {@link SetupStep}, answering `null` for
 * anything else.
 *
 * Fail safe on purpose: a row hand-edited to a step this build does not know
 * must read as "no bookmark" rather than become a redirect target the wizard
 * cannot render.
 *
 * @param value - the raw `user_meta.setup_step` value
 */
export function asSetupStep(value: string | null | undefined): SetupStep | null {
  return value != null && (SETUP_STEPS as readonly string[]).includes(value) ? (value as SetupStep) : null;
}
