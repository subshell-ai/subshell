/**
 * Selectable rows first, greyed ones after, each group in the order it arrived.
 *
 * A list whose usable rows are scattered among refusals reads as broken, and
 * this product generates that shape on every fresh machine: one agent CLI is
 * installed and the rest are offered greyed, so the row a person can actually
 * pick lands under a wall of "not installed" (user reports 2026-09-11, twice —
 * the launch form's Agent picker, then the profile dialog's Harness picker).
 *
 * Greying rather than hiding stays the rule: a reader has to be able to see
 * that Codex exists and why it cannot run here. What belongs where the hand
 * lands is the part that works; the reasons belong under it.
 *
 * The partition is STABLE on purpose. Within each group the caller's order is
 * meaningful — profiles arrive sorted, nodes arrive with the control plane's
 * own row first, harnesses arrive in registry order — and re-sorting to group
 * by reason would trade one confusing order for another.
 *
 * @param items - the rows, in the order the caller chose
 * @param usable - whether a row can be picked; everything else sinks
 */
export function usableFirst<T>(items: readonly T[], usable: (item: T) => boolean): T[] {
  return [...items.filter((item) => usable(item)), ...items.filter((item) => !usable(item))];
}
