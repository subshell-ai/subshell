import { SPLIT_DIRECTIONS, type SplitDirection } from "@/types/workspace";

/**
 * The "split this subshell in" instruction a freshly created draft workspace
 * carries in its URL (`/workspaces/$id?add=<subshellId>&dir=<direction>`).
 *
 * It exists because the second pane cannot be created in the same request as
 * the draft: the picker chose a subshell (or launched one), and the workspace
 * page is what adds it — through the same `handleAdd` path every later add
 * uses, so the chosen direction is honoured by the same code.
 */
export interface SplitIntent {
  /** Subshell to attach as a second pane */
  subshellId: string;
  /** Where to put it relative to the pane already there */
  direction: SplitDirection;
}

/** Direction used when the URL names none, or names one this build does not know. */
const DEFAULT_SPLIT_DIRECTION: SplitDirection = "right";

/**
 * Reads a split intent off the workspace route's search params.
 *
 * `add` is the intent: a non-empty string subshell id, or there is nothing to
 * do (`null`). `dir` is only a preference, so a missing, misspelled or
 * non-string one falls back to {@link DEFAULT_SPLIT_DIRECTION} rather than
 * discarding the split — a hand-edited or stale URL still puts the pane on
 * screen, which is what the person asked for.
 * @param search - The route's parsed search params, values still `unknown`
 * @returns The intent, or null when no subshell is named
 */
export function parseSplitIntent(search: { add?: unknown; dir?: unknown }): SplitIntent | null {
  const subshellId = typeof search.add === "string" ? search.add : "";
  if (!subshellId) return null;
  const direction = SPLIT_DIRECTIONS.find((d) => d === search.dir) ?? DEFAULT_SPLIT_DIRECTION;
  return { subshellId, direction };
}
