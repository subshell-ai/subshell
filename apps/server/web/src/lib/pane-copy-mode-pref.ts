/**
 * Which subshells are in COPY MODE on this device (issue 242). Exactly the
 * same per-DEVICE, per-subshell tier as `pane-diagnostics-pref` and for the
 * same reasons: a selection gesture you asked for on this screen is a
 * property of the screen, not of the account; the set holds the TURNED-ON
 * ids because off is the default; keyed by subshell ID so a rename changes
 * no stored preference; and every access is try/catch'd because private-mode
 * Safari throws on `localStorage` outright.
 */

/** JSON array of subshell ids whose pane is in copy mode on this device. */
const KEY = "subshell.paneCopyMode";

/**
 * The turned-on set, or an empty array for absent/corrupt/blocked storage.
 * A half-written or hand-edited value is filtered to the strings inside it
 * rather than thrown away wholesale.
 */
export function paneCopyModeIds(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Persists the set.
 *
 * @param ids - the set as it should now be stored
 * @returns the same set, so callers bind their render to what was stored
 *          rather than to what they intended to store
 */
export function setPaneCopyModeIds(ids: readonly string[]): string[] {
  const next = [...ids];
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage refused: the choice still holds for this page load, which is
    // the part the user is looking at.
  }
  return next;
}

/**
 * The set with one subshell's copy mode flipped. Pure, so the caller decides
 * whether to persist it and a test can exercise the rule without a storage
 * backend.
 */
export function togglePaneCopyMode(ids: readonly string[], subshellId: string): string[] {
  return ids.includes(subshellId) ? ids.filter((id) => id !== subshellId) : [...ids, subshellId];
}
