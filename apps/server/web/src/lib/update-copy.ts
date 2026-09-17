/**
 * Wording shared by the Updates page's rows (spec 2026-09-15 §10).
 *
 * In `lib/` rather than inside one row because the Server row and the Nodes
 * rows render the same server-supplied reasons, and a helper exported from one
 * and imported by the other is a dependency between two things that are
 * otherwise siblings.
 */

/**
 * A server-supplied reason, ended exactly once.
 *
 * The reasons come from several places and they do not agree about
 * punctuation: `restart.reason` is a whole sentence ending in a full stop,
 * while `canApply`'s own strings are clauses. Appending one unconditionally
 * renders "restart it where you started it..", which reads as a defect in the
 * product rather than in the string — measured on the e2e stack, which is
 * exactly the unsupervised host that produces that reason.
 */
export function endOnce(reason: string): string {
  return /[.!?]$/.test(reason) ? reason : `${reason}.`;
}
