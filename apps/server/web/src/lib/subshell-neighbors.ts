/** The ordered-list half of prev/next swipe navigation (spec 2026-09-04). */

/** The id-list neighbours of `id` in an already-ordered list. Ends never wrap;
 * an id not in the list (just created, not yet announced) has no neighbours. */
export function findNeighbors<T extends { id: string }>(
  ordered: readonly T[],
  id: string,
): { prev: string | null; next: string | null } {
  const i = ordered.findIndex((s) => s.id === id);
  if (i === -1) return { prev: null, next: null };
  return {
    prev: i > 0 ? ordered[i - 1].id : null,
    next: i < ordered.length - 1 ? ordered[i + 1].id : null,
  };
}
