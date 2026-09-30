/**
 * "Recently used" memory for the launch form's Preset picker (operator
 * ruling 2026-09-30), mirroring the prompt picker's memory of 2026-09-29:
 * the presets you actually pick, most recent first, kept in this browser
 * across sessions. Only the picker's EXPLICIT picks land here - the
 * auto-default tier that opens the form on your last launch never claims a
 * use it did not make, and the preset a create dialog just saved counts
 * (it became the selection).
 *
 * The list is deliberately LONGER than what the picker shows: the header
 * leads with only three, but the backlog means a still-existing preset
 * surfaces when a newer pick is deleted. Storage is best-effort: blocked or
 * malformed reads fall back to empty, never throwing into a render.
 */

const KEY = "subshell/recent-preset-picks";
const MAX_TRACKED = 24;

/** Most-recent-first preset ids, read defensively (a manual edit or a
 *  future shape yields the empty list rather than poisoning the picker). */
export function loadRecentPresetPicks(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === "string").slice(0, MAX_TRACKED);
  } catch {
    return [];
  }
}

/** Move the picked id to the head, de-dupe, bound, persist, and return the
 *  new list so the caller re-renders the sections without another read. */
export function recordRecentPresetPick(id: string): string[] {
  const next = [id, ...loadRecentPresetPicks().filter((e) => e !== id)].slice(0, MAX_TRACKED);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage blocked or full: the memory is best-effort, the pick still lands */
  }
  return next;
}
