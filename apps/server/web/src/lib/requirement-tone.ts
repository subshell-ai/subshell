/**
 * The tone of an UNMET-REQUIREMENT caption: a required field still empty, a
 * launch gap holding a switch back, the line that says why Save is dead.
 * The app's warning amber (operator ruling 2026-09-30, "all forms"): every
 * requirement not yet met reads alike wherever it is named, so one
 * constant, never a per-site class string.
 *
 * A FAILED value - a mismatch, a too-short password, the server's refusal -
 * is a different fact and stays `text-destructive`. The line between them:
 * amber says "nothing typed yet", red says "what you typed is wrong".
 */
export const REQUIREMENT_GAP_CLASS = "text-amber-600 text-detail dark:text-amber-400";
